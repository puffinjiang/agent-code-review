import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Installer } from "../src/lib/installer.js";
import { ProcessLock } from "../src/lib/lock.js";
import { Uninstaller } from "../src/lib/uninstaller.js";

function symlinksAvailable(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "acr-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(probe, "target"), "x");
    fs.symlinkSync(path.join(probe, "target"), path.join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}
const canSymlink = symlinksAvailable();

interface LockOwnerPayload {
  pid: number;
  token: string;
  time: number;
}

function ownerPathFor(lockPath: string, token: string): string {
  return path.join(lockPath, `owner-${token}.json`);
}

function createDirLock(lockPath: string, data: LockOwnerPayload): string {
  fs.mkdirSync(lockPath, { recursive: true });
  const filePath = ownerPathFor(lockPath, data.token);
  fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
  return filePath;
}

function readActiveOwner(lockPath: string): {
  fileName: string;
  filePath: string;
  raw: string;
  data: LockOwnerPayload;
} {
  const entries = fs.readdirSync(lockPath);
  expect(entries).toHaveLength(1);
  const fileName = entries[0];
  const filePath = path.join(lockPath, fileName);
  const raw = fs.readFileSync(filePath, "utf-8");
  return {
    fileName,
    filePath,
    raw,
    data: JSON.parse(raw) as LockOwnerPayload,
  };
}

describe("ProcessLock Unit Tests", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acr-lock-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should acquire and release directory lock cleanly", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    expect(fs.existsSync(lockPath)).toBe(false);

    const release = ProcessLock.acquire(tempDir);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.statSync(lockPath).isDirectory()).toBe(true);
    const owner = readActiveOwner(lockPath);
    expect(owner.data.pid).toBe(process.pid);
    expect(owner.fileName).toBe(`owner-${owner.data.token}.json`);

    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should execute withLock callback and release lock", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    let ran = false;

    const result = ProcessLock.withLock(tempDir, () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.statSync(lockPath).isDirectory()).toBe(true);
      ran = true;
      return "success";
    });

    expect(ran).toBe(true);
    expect(result).toBe("success");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should validate PID liveness and reject non-positive or non-integer PIDs (D-14)", () => {
    expect(ProcessLock.isPidAlive(process.pid)).toBe(true);
    expect(ProcessLock.isPidAlive(999999999)).toBe(false);
    expect(ProcessLock.isPidAlive(0)).toBe(false);
    expect(ProcessLock.isPidAlive(-1)).toBe(false);
    expect(ProcessLock.isPidAlive(NaN)).toBe(false);
    expect(ProcessLock.isPidAlive(1.5)).toBe(false);
  });

  it("should break dead pid lock automatically (both directory lock and legacy regular file)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    createDirLock(lockPath, {
      pid: 999999999,
      token: "dead-pid-token",
      time: Date.now() - 5000,
    });
    expect(fs.existsSync(lockPath)).toBe(true);

    const release = ProcessLock.acquire(tempDir, { timeoutMs: 1000 });
    expect(fs.statSync(lockPath).isDirectory()).toBe(true);
    expect(readActiveOwner(lockPath).data.pid).toBe(process.pid);
    release();
    expect(fs.existsSync(lockPath)).toBe(false);

    // 兼容清理旧版本单文件死锁
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999999, token: "legacy-dead-token", time: Date.now() - 5000 }),
      "utf-8",
    );
    const releaseAfterLegacy = ProcessLock.acquire(tempDir, { timeoutMs: 1000 });
    expect(fs.statSync(lockPath).isDirectory()).toBe(true);
    releaseAfterLegacy();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should never steal a live process lock held by an active process (V-1 / D-14)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const releaseA = ProcessLock.acquire(tempDir);
    try {
      const before = readActiveOwner(lockPath);
      expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 150, retryIntervalMs: 25 })).toThrow(
        /获取安装锁超时/,
      );
      expect(readActiveOwner(lockPath).raw).toBe(before.raw);
    } finally {
      releaseA();
    }
  });

  it("should never steal a live process lock merely because its age is old", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const agedToken = "aged-live-token";
    const ownerFile = createDirLock(lockPath, {
      pid: process.pid,
      token: agedToken,
      time: Date.now() - 60000,
    });
    const oldTime = new Date(Date.now() - 60000);
    fs.utimesSync(ownerFile, oldTime, oldTime);

    expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 200, retryIntervalMs: 25 })).toThrow(
      /获取安装锁超时/,
    );
    expect(fs.existsSync(ownerFile)).toBe(true);
    expect(readActiveOwner(lockPath).data.token).toBe(agedToken);
  });

  it("should print holding notification to stderr if waiting exceeds 300ms", async () => {
    const releaseA = ProcessLock.acquire(tempDir);
    const stderrSpy: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrSpy.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 400, retryIntervalMs: 50 })).toThrow(
        /获取安装锁超时/,
      );

      expect(stderrSpy.some((s) => s.includes("⏳ 检测到另一个 agent-code-review 正在运行"))).toBe(
        true,
      );
      expect(stderrSpy.some((s) => s.includes("锁路径:"))).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
      releaseA();
    }
  });

  it("should not delete another holder's lock when an expired holder calls release() (V-2 TOCTOU)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const tokenA = "stale-token-a";
    createDirLock(lockPath, { pid: 999999999, token: tokenA, time: Date.now() - 5000 });

    const releaseB = ProcessLock.acquire(tempDir, { timeoutMs: 1000 });
    const ownerB = readActiveOwner(lockPath);
    const tokenB = ownerB.data.token;
    expect(tokenB).not.toBe(tokenA);

    ProcessLock.release(lockPath, tokenA);

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readActiveOwner(lockPath).data.token).toBe(tokenB);

    releaseB();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should refuse and never delete foreign files or foreign directories at lockPath (V-6)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const oldTime = new Date(Date.now() - 2000);

    // 1. Plain text foreign regular file
    const foreignContent = "user custom data or git tracked lock content";
    fs.writeFileSync(lockPath, foreignContent, "utf-8");
    fs.utimesSync(lockPath, oldTime, oldTime);

    expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 200, retryIntervalMs: 25 })).toThrow(
      /contains an invalid or foreign file\. Refusing to overwrite/,
    );
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(foreignContent);

    // 2. Foreign JSON regular file containing numeric pid without ACR token/time
    const foreignJson = JSON.stringify({ pid: 999999999, userdata: "IMPORTANT" });
    fs.writeFileSync(lockPath, foreignJson, "utf-8");
    fs.utimesSync(lockPath, oldTime, oldTime);

    expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 200, retryIntervalMs: 25 })).toThrow(
      /contains an invalid or foreign file\. Refusing to overwrite/,
    );
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(foreignJson);

    // 3. Foreign regular JSON with pid: 0
    const foreignPidZero = JSON.stringify({
      pid: 0,
      token: "non-positive-pid",
      time: Date.now() - 2000,
      data: "KEEP",
    });
    fs.writeFileSync(lockPath, foreignPidZero, "utf-8");
    fs.utimesSync(lockPath, oldTime, oldTime);

    expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 200, retryIntervalMs: 25 })).toThrow(
      /contains an invalid or foreign file\. Refusing to overwrite/,
    );
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(foreignPidZero);

    // 4. Foreign non-empty directory at lockPath containing user files (must not crash with EISDIR)
    fs.unlinkSync(lockPath);
    fs.mkdirSync(lockPath);
    const userNotePath = path.join(lockPath, "keep-user-notes.txt");
    fs.writeFileSync(userNotePath, "precious user file", "utf-8");

    expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 200, retryIntervalMs: 25 })).toThrow(
      /contains an invalid or foreign directory\. Refusing to overwrite/,
    );
    expect(fs.readFileSync(userNotePath, "utf-8")).toBe("precious user file");
  });

  it("should automatically recover 0-byte abandoned lock files and empty lock directories (F-4)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const oldTime = new Date(Date.now() - 2000);

    // 1. 0-byte owner file older than 500ms inside lockPath
    fs.mkdirSync(lockPath);
    const emptyOwner = ownerPathFor(lockPath, "crashed-owner");
    fs.writeFileSync(emptyOwner, "", "utf-8");
    fs.utimesSync(emptyOwner, oldTime, oldTime);

    const release1 = ProcessLock.acquire(tempDir, { timeoutMs: 1000 });
    expect(fs.statSync(lockPath).isDirectory()).toBe(true);
    expect(readActiveOwner(lockPath).data.pid).toBe(process.pid);
    release1();
    expect(fs.existsSync(lockPath)).toBe(false);

    // 2. Empty lockPath directory left if process crashed between unlink(owner) and rmdir(lockPath)
    fs.mkdirSync(lockPath);
    const release2 = ProcessLock.acquire(tempDir, { timeoutMs: 1000 });
    expect(fs.statSync(lockPath).isDirectory()).toBe(true);
    expect(readActiveOwner(lockPath).data.pid).toBe(process.pid);
    release2();
    expect(fs.existsSync(lockPath)).toBe(false);

    // 3. 0-byte legacy regular file older than 500ms
    fs.writeFileSync(lockPath, "", "utf-8");
    fs.utimesSync(lockPath, oldTime, oldTime);
    const release3 = ProcessLock.acquire(tempDir, { timeoutMs: 1000 });
    expect(fs.statSync(lockPath).isDirectory()).toBe(true);
    release3();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "should report exact EACCES error and remediation guidance when lock directory is unreadable (mode 000) (O-3)",
    () => {
      const lockPath = ProcessLock.getLockPath(tempDir);
      createDirLock(lockPath, { pid: process.pid, token: "secret", time: Date.now() });
      fs.chmodSync(lockPath, 0o000);

      try {
        try {
          ProcessLock.acquire(tempDir, { timeoutMs: 200 });
          expect.unreachable("should have thrown");
        } catch (err: unknown) {
          expect((err as NodeJS.ErrnoException).code).toBe("EACCES");
          expect((err as Error).message).toMatch(/无法读取安装锁目录（权限不足\/EACCES）/);
          expect((err as Error).message).toMatch(/rm/);
        }
      } finally {
        try {
          fs.chmodSync(lockPath, 0o755);
        } catch {}
      }
    },
  );

  it("should safely leave lock untouched if token changed before reclaim (O-2)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    createDirLock(lockPath, { pid: 99999, token: "new-holder-token", time: Date.now() });

    (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim(
      lockPath,
      "old-token",
    );

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readActiveOwner(lockPath).data.token).toBe("new-holder-token");

    (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim(
      lockPath,
      "new-holder-token",
    );
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should never delete foreign non-empty file or directory when reclaim is invoked with null (V-6)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    fs.writeFileSync(lockPath, "user foreign file content", "utf-8");

    (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim(
      lockPath,
      null,
    );
    expect(fs.readFileSync(lockPath, "utf-8")).toBe("user foreign file content");

    fs.unlinkSync(lockPath);
    fs.mkdirSync(lockPath);
    const foreignInDir = path.join(lockPath, "foreign.txt");
    fs.writeFileSync(foreignInDir, "keep-me", "utf-8");

    (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim(
      lockPath,
      null,
    );
    expect(fs.readFileSync(foreignInDir, "utf-8")).toBe("keep-me");
  });

  it("should safely reclaim empty directory and 0-byte owner entry when reclaim is invoked with null (V-6)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    fs.mkdirSync(lockPath);

    (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim(
      lockPath,
      null,
    );
    expect(fs.existsSync(lockPath)).toBe(false);

    fs.mkdirSync(lockPath);
    fs.writeFileSync(ownerPathFor(lockPath, "empty-entry"), "", "utf-8");
    (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim(
      lockPath,
      null,
    );
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should preserve timeout error message with PID info (C-2)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    createDirLock(lockPath, { pid: process.pid, token: "other", time: Date.now() });

    try {
      expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 100, retryIntervalMs: 20 })).toThrow(
        new RegExp(`获取安装锁超时.*PID: ${process.pid}`),
      );
    } finally {
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {}
    }
  });

  it.skipIf(!canSymlink)(
    "should refuse live and dangling symlinks at lock path immediately and return structured error in Installer/Uninstaller (D-14)",
    () => {
      const lockPath = ProcessLock.getLockPath(tempDir);
      const externalTarget = path.join(tempDir, "external.txt");
      fs.writeFileSync(externalTarget, "keep-me", "utf-8");

      // 1. Live symlink at .agent-code-review.lock
      fs.symlinkSync(externalTarget, lockPath);
      const startLive = Date.now();
      expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 5000 })).toThrow(
        /Refusing symbolic link/,
      );
      expect(Date.now() - startLive).toBeLessThan(1000);
      expect(fs.readFileSync(externalTarget, "utf-8")).toBe("keep-me");

      const installRes = new Installer({ homeDir: tempDir, platform: "antigravity" }).execute();
      expect(installRes.success).toBe(false);
      expect(installRes.errors[0]).toMatch(/Refusing symbolic link/);

      const uninstallRes = new Uninstaller({ homeDir: tempDir }).execute();
      expect(uninstallRes.success).toBe(false);
      expect(uninstallRes.errors[0]).toMatch(/Refusing symbolic link/);

      // 2. Dangling symlink at .agent-code-review.lock
      fs.unlinkSync(externalTarget);
      const startDangling = Date.now();
      expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 5000 })).toThrow(
        /Refusing symbolic link/,
      );
      expect(Date.now() - startDangling).toBeLessThan(1000);
    },
  );

  it("should not delete a replaced lock with a different inode even if owner token matches (conc-003)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const releaseA = ProcessLock.acquire(tempDir);
    const originalOwner = readActiveOwner(lockPath);

    const replacementDir = path.join(tempDir, "replacement-lock-dir");
    createDirLock(replacementDir, originalOwner.data);
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.renameSync(replacementDir, lockPath);

    releaseA();
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readActiveOwner(lockPath).raw).toBe(originalOwner.raw);
  });

  it("should never vacate lockPath or delete a mismatched lock by inode during reclaim (conc-004)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const ownerFileBefore = createDirLock(lockPath, {
      pid: process.pid,
      token: "same-token",
      time: Date.now(),
    });
    const statBefore = fs.statSync(ownerFileBefore);

    const replacementDir = path.join(tempDir, "replacement-reclaim-dir");
    createDirLock(replacementDir, { pid: process.pid, token: "same-token", time: Date.now() });
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.renameSync(replacementDir, lockPath);

    const reclaimFn = (
      ProcessLock as unknown as {
        reclaim: (p: string, t: string | null, id?: { dev: number; ino: number }) => void;
      }
    ).reclaim.bind(ProcessLock);

    reclaimFn(lockPath, "same-token", { dev: statBefore.dev, ino: statBefore.ino });
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readActiveOwner(lockPath).data.token).toBe("same-token");
  });

  it("should not delete a new holder's lock when preempted between check and unlink (release & reclaim)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);

    // 1. release() 被抢占在读取校验与 unlink(owner) 之间
    createDirLock(lockPath, { pid: process.pid, token: "old-token-a", time: Date.now() });
    let releaseNewHolder: (() => void) | undefined;
    const origReadOpened = (
      ProcessLock as unknown as { readOpenedLock: (p: string) => unknown }
    ).readOpenedLock.bind(ProcessLock);

    const readSpy = vi
      .spyOn(ProcessLock as unknown as { readOpenedLock: (p: string) => unknown }, "readOpenedLock")
      .mockImplementationOnce((p: string) => {
        const opened = origReadOpened(p);
        readSpy.mockRestore();
        fs.rmSync(lockPath, { recursive: true, force: true });
        releaseNewHolder = ProcessLock.acquire(tempDir);
        return opened;
      });

    ProcessLock.release(lockPath, "old-token-a");
    expect(fs.existsSync(lockPath)).toBe(true);
    const activeTokenAfterReleaseRace = readActiveOwner(lockPath).data.token;
    expect(activeTokenAfterReleaseRace).not.toBe("old-token-a");
    releaseNewHolder?.();
    expect(fs.existsSync(lockPath)).toBe(false);

    // 2. reclaim() 被抢占在读取校验与 unlink(owner) 之间
    createDirLock(lockPath, { pid: 999999999, token: "dead-token-a", time: Date.now() });
    let releaseHolderAfterReclaimRace: (() => void) | undefined;
    const readSpy2 = vi
      .spyOn(ProcessLock as unknown as { readOpenedLock: (p: string) => unknown }, "readOpenedLock")
      .mockImplementationOnce((p: string) => {
        const opened = origReadOpened(p);
        readSpy2.mockRestore();
        fs.rmSync(lockPath, { recursive: true, force: true });
        releaseHolderAfterReclaimRace = ProcessLock.acquire(tempDir);
        return opened;
      });

    (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim(
      lockPath,
      "dead-token-a",
    );
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readActiveOwner(lockPath).data.token).not.toBe("dead-token-a");
    releaseHolderAfterReclaimRace?.();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should never remove a new holder's lock when preempted between unlink(owner) and rmdir(lockPath)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const releaseA = ProcessLock.acquire(tempDir);
    let releaseB: (() => void) | undefined;

    const origTryRmdir = (
      ProcessLock as unknown as { tryRmdirIfEmpty: (d: string) => void }
    ).tryRmdirIfEmpty.bind(ProcessLock);

    const rmdirSpy = vi
      .spyOn(ProcessLock as unknown as { tryRmdirIfEmpty: (d: string) => void }, "tryRmdirIfEmpty")
      .mockImplementationOnce((dirPath: string) => {
        rmdirSpy.mockRestore();
        // 此时 unlink(owner-A) 已完成、lockPath 为空目录；模拟 B 在 rmdir(lockPath) 前抢先占锁
        releaseB = ProcessLock.acquire(tempDir);
        // 恢复 A 线程的 rmdir(lockPath)：内核必须因目录非空（含 owner-B）而拒绝删除 B 的锁
        origTryRmdir(dirPath);
      });

    releaseA();
    expect(fs.existsSync(lockPath)).toBe(true);
    const ownerB = readActiveOwner(lockPath);
    expect(ownerB.data.pid).toBe(process.pid);
    // C 尝试拿锁仍必须互斥等待并超时，不能突破 B 的锁
    expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 80, retryIntervalMs: 20 })).toThrow(
      /获取安装锁超时/,
    );

    releaseB?.();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.skipIf(!canSymlink)(
    "should refuse symlinks in release() and reclaim() even when target contains a matching token or owner file",
    () => {
      const lockPath = ProcessLock.getLockPath(tempDir);
      const token = "matching-token";

      // 1. Symlink pointing to regular file
      const targetFile = path.join(tempDir, "target-lock.json");
      fs.writeFileSync(
        targetFile,
        JSON.stringify({ pid: process.pid, token, time: Date.now() }),
        "utf-8",
      );
      fs.symlinkSync(targetFile, lockPath);

      ProcessLock.release(lockPath, token);
      expect(fs.lstatSync(lockPath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(targetFile)).toBe(true);

      (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim.call(
        ProcessLock,
        lockPath,
        token,
      );
      expect(fs.lstatSync(lockPath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(targetFile)).toBe(true);

      // 2. Symlink pointing to a directory containing owner-<token>.json
      fs.unlinkSync(lockPath);
      const targetDir = path.join(tempDir, "target-lock-dir");
      const targetOwner = createDirLock(targetDir, { pid: process.pid, token, time: Date.now() });
      fs.symlinkSync(targetDir, lockPath);

      ProcessLock.release(lockPath, token);
      expect(fs.lstatSync(lockPath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(targetOwner)).toBe(true);

      (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim.call(
        ProcessLock,
        lockPath,
        token,
      );
      expect(fs.lstatSync(lockPath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(targetOwner)).toBe(true);
    },
  );
});
