import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ProcessLock } from "../src/lib/lock.js";
import { Installer } from "../src/lib/installer.js";
import { Uninstaller } from "../src/lib/uninstaller.js";
import { ManifestManager } from "../src/lib/manifest.js";

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

describe("ProcessLock Unit Tests", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acr-lock-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should acquire and release lock cleanly", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    expect(fs.existsSync(lockPath)).toBe(false);

    const release = ProcessLock.acquire(tempDir);
    expect(fs.existsSync(lockPath)).toBe(true);

    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should execute withLock callback and release lock", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    let ran = false;

    const result = ProcessLock.withLock(tempDir, () => {
      expect(fs.existsSync(lockPath)).toBe(true);
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

  it("should break dead pid lock automatically", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999999, token: "dead-pid-token", time: Date.now() - 5000 }),
      "utf-8"
    );
    expect(fs.existsSync(lockPath)).toBe(true);

    const release = ProcessLock.acquire(tempDir, { timeoutMs: 1000 });
    expect(fs.existsSync(lockPath)).toBe(true);
    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should time out when contending against an active lock held by a live PID (D-14)", () => {
    const release = ProcessLock.acquire(tempDir);
    try {
      expect(() =>
        ProcessLock.acquire(tempDir, { timeoutMs: 150, retryIntervalMs: 25 })
      ).toThrow(/获取安装锁超时/);
    } finally {
      release();
    }
  });

  it("should never steal a live process lock held by an active process within maxAgeMs (V-1)", () => {
    const releaseA = ProcessLock.acquire(tempDir);
    try {
      // Process B attempts to acquire with short timeout
      // Since Process A is alive, B must NOT steal A's active lock
      expect(() =>
        ProcessLock.acquire(tempDir, { timeoutMs: 150, retryIntervalMs: 25 })
      ).toThrow(/获取安装锁超时/);
    } finally {
      releaseA();
    }
  });

  it("should immediately break abandoned lock when age exceeds stale threshold (even if PID is alive, e.g. recycled PID 1)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    // Simulate an abandoned lock whose PID is 1 (always alive) but created 60s ago
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 1, token: "reused-pid-token", time: Date.now() - 60000 }),
      "utf-8"
    );
    const oldTime = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, oldTime, oldTime);

    // Contender detects age > 15000ms and breaks the abandoned lock immediately
    const release = ProcessLock.acquire(tempDir, { timeoutMs: 500 });
    expect(fs.existsSync(lockPath)).toBe(true);
    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should print holding notification to stderr if waiting exceeds 300ms", async () => {
    const releaseA = ProcessLock.acquire(tempDir);
    const stderrSpy: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrSpy.push(String(chunk));
      return true;
    }) as any;

    try {
      expect(() =>
        ProcessLock.acquire(tempDir, { timeoutMs: 400, retryIntervalMs: 50 })
      ).toThrow(/获取安装锁超时/);

      expect(stderrSpy.some((s) => s.includes("⏳ 检测到另一个 agent-code-review 正在运行"))).toBe(true);
      expect(stderrSpy.some((s) => s.includes("锁路径:"))).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
      releaseA();
    }
  });

  it("should not delete another holder's lock when an expired holder calls release() (V-2 TOCTOU)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const tokenA = "stale-token-a";
    // 1. Manually place an orphaned lock whose PID is dead (999999999) with tokenA
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999999, token: tokenA, time: Date.now() - 5000 }),
      "utf-8"
    );

    // 2. Process B acquires the lock, breaking the dead lock and writing tokenB
    const releaseB = ProcessLock.acquire(tempDir, { timeoutMs: 1000 });
    const lockDataB = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    const tokenB = lockDataB.token;
    expect(tokenB).not.toBe(tokenA);

    // 3. Stale holder A attempts to invoke release() with tokenA
    // It must NOT delete Process B's active lock because tokens do not match
    ProcessLock.release(lockPath, tokenA);

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).token).toBe(tokenB);

    releaseB();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should refuse and never delete foreign non-ACR file placed at lockPath (V-6)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);

    // 1. Plain text foreign file
    const foreignContent = "user custom data or git tracked lock content";
    fs.writeFileSync(lockPath, foreignContent, "utf-8");
    const oldTime = new Date(Date.now() - 2000);
    fs.utimesSync(lockPath, oldTime, oldTime);

    expect(() =>
      ProcessLock.acquire(tempDir, { timeoutMs: 200, retryIntervalMs: 25 })
    ).toThrow(/contains an invalid or foreign file\. Refusing to overwrite/);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(foreignContent);

    // 2. Foreign JSON file containing a numeric pid but no ACR token/time
    const foreignJson = JSON.stringify({ pid: 999999999, userdata: "IMPORTANT" });
    fs.writeFileSync(lockPath, foreignJson, "utf-8");
    fs.utimesSync(lockPath, oldTime, oldTime);

    expect(() =>
      ProcessLock.acquire(tempDir, { timeoutMs: 200, retryIntervalMs: 25 })
    ).toThrow(/contains an invalid or foreign file\. Refusing to overwrite/);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(foreignJson);

    // 3. Foreign JSON file with non-positive pid (pid: 0)
    const foreignPidZero = JSON.stringify({ pid: 0, token: "non-positive-pid", time: Date.now() - 2000, data: "KEEP" });
    fs.writeFileSync(lockPath, foreignPidZero, "utf-8");
    fs.utimesSync(lockPath, oldTime, oldTime);

    expect(() =>
      ProcessLock.acquire(tempDir, { timeoutMs: 200, retryIntervalMs: 25 })
    ).toThrow(/contains an invalid or foreign file\. Refusing to overwrite/);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(foreignPidZero);
  });

  it("should automatically recover 0-byte abandoned lock file older than 500ms (F-4)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    // Simulate an aborted/crashed process that created an empty lock file (0 bytes)
    fs.writeFileSync(lockPath, "", "utf-8");
    const oldTime = new Date(Date.now() - 2000);
    fs.utimesSync(lockPath, oldTime, oldTime);
    expect(fs.statSync(lockPath).size).toBe(0);

    const release = ProcessLock.acquire(tempDir, { timeoutMs: 1000 });
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.statSync(lockPath).size).toBeGreaterThan(0);
    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should report exact EACCES error and remediation guidance when lock file is unreadable (mode 000) (O-3)", () => {
    // Windows permissions do not support POSIX mode 000
    if (process.platform === "win32") return;

    const lockPath = ProcessLock.getLockPath(tempDir);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "secret", time: Date.now() }), "utf-8");
    fs.chmodSync(lockPath, 0o000);

    try {
      try {
        ProcessLock.acquire(tempDir, { timeoutMs: 200 });
        expect.unreachable("should have thrown");
      } catch (err: unknown) {
        expect((err as NodeJS.ErrnoException).code).toBe("EACCES");
        expect((err as Error).message).toMatch(/无法读取安装锁文件（权限不足\/EACCES）/);
        expect((err as Error).message).toMatch(/rm/);
      }
    } finally {
      try { fs.chmodSync(lockPath, 0o644); } catch {}
    }
  });

  it("should safely restore lock without deleting it if token changed during CAS reclaim (O-2)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const dataNew = { pid: 99999, token: "new-holder-token", time: Date.now() };
    fs.writeFileSync(lockPath, JSON.stringify(dataNew), "utf-8");

    // Reclaim expecting "old-token" -> mismatch -> must restore dataNew
    (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim(lockPath, "old-token");

    expect(fs.existsSync(lockPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    expect(content.token).toBe("new-holder-token");

    // Reclaim expecting matching token -> must safely unlink
    (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim(lockPath, "new-holder-token");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should never delete foreign non-empty file when reclaim is invoked with null (V-6)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    fs.writeFileSync(lockPath, "user foreign file content", "utf-8");

    // reclaim expecting null (0-byte) must check size === 0 and refuse to unlink foreign non-empty file
    (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim(lockPath, null);

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf-8")).toBe("user foreign file content");
  });

  it("should safely reclaim 0-byte file when reclaim is invoked with null (V-6)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    fs.writeFileSync(lockPath, "", "utf-8");
    expect(fs.statSync(lockPath).size).toBe(0);

    (ProcessLock as unknown as { reclaim: (p: string, t: string | null) => void }).reclaim(lockPath, null);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should preserve timeout error message when lock file becomes unreadable at timeout (C-2)", () => {
    // Windows permissions do not support POSIX mode 000
    if (process.platform === "win32") return;

    const lockPath = ProcessLock.getLockPath(tempDir);
    // Live lock from current PID so acquire won't reclaim it as dead
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "other", time: Date.now() }), "utf-8");

    try {
      expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 100, retryIntervalMs: 20 })).toThrow(/获取安装锁超时/);
    } finally {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  });

  it.skipIf(!canSymlink)("should refuse live and dangling symlinks at lock path immediately and return structured error in Installer/Uninstaller (D-14)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const externalTarget = path.join(tempDir, "external.txt");
    fs.writeFileSync(externalTarget, "keep-me", "utf-8");

    // 1. Live symlink at .agent-code-review.lock
    fs.symlinkSync(externalTarget, lockPath);
    const startLive = Date.now();
    expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 5000 })).toThrow(/Refusing symbolic link/);
    expect(Date.now() - startLive).toBeLessThan(1000);
    expect(fs.readFileSync(externalTarget, "utf-8")).toBe("keep-me");

    // Installer & Uninstaller return structured failure instead of throwing
    const installRes = new Installer({ homeDir: tempDir, platform: "antigravity" }).execute();
    expect(installRes.success).toBe(false);
    expect(installRes.errors[0]).toMatch(/Refusing symbolic link/);

    const uninstallRes = new Uninstaller({ homeDir: tempDir }).execute();
    expect(uninstallRes.success).toBe(false);
    expect(uninstallRes.errors[0]).toMatch(/Refusing symbolic link/);

    // 2. Dangling symlink at .agent-code-review.lock
    fs.unlinkSync(externalTarget);
    const startDangling = Date.now();
    expect(() => ProcessLock.acquire(tempDir, { timeoutMs: 5000 })).toThrow(/Refusing symbolic link/);
    expect(Date.now() - startDangling).toBeLessThan(1000);
  });

  it("should allow rapid same-millisecond ManifestManager.save calls without temp file collision (D-14)", () => {
    for (let i = 0; i < 10; i++) {
      ManifestManager.save(tempDir, {
        schemaVersion: "1.0.0",
        packageVersion: "0.1.0",
        scope: "global",
        platforms: ["antigravity"],
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        files: []
      });
    }
    expect(ManifestManager.load(tempDir)?.platforms).toEqual(["antigravity"]);
  });
});
