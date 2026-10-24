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
      JSON.stringify({ pid: 999999999, time: Date.now() - 5000 }),
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
        ProcessLock.acquire(tempDir, { timeoutMs: 150, retryIntervalMs: 25, staleMs: 60000 })
      ).toThrow(/Failed to acquire lock/);
    } finally {
      release();
    }
  });

  it("should never break lock if holder PID is alive, even if age exceeds staleMs (V-1)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    // Process A (current live process) acquires lock
    const releaseA = ProcessLock.acquire(tempDir);
    try {
      // Backdate lock mtime by 60 seconds
      const oldTime = new Date(Date.now() - 60000);
      fs.utimesSync(lockPath, oldTime, oldTime);

      // Process B attempts to acquire with staleMs = 1000, timeoutMs = 200
      // Since PID is alive, B must NOT steal A's active lock
      expect(() =>
        ProcessLock.acquire(tempDir, { staleMs: 1000, timeoutMs: 200, retryIntervalMs: 25 })
      ).toThrow(/Failed to acquire lock/);

      // The original lock held by A must still be intact
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
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
    // With V-2 atomic release, it must NOT delete Process B's active lock
    // @ts-expect-error accessing private release for unit testing TOCTOU safety
    ProcessLock.release(lockPath, tokenA);

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).token).toBe(tokenB);

    releaseB();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("should refuse and never delete foreign non-ACR file placed at lockPath (V-6)", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    const foreignContent = "user custom data or git tracked lock content";
    fs.writeFileSync(lockPath, foreignContent, "utf-8");
    // Backdate by 2 seconds so it's not considered mid-write
    const oldTime = new Date(Date.now() - 2000);
    fs.utimesSync(lockPath, oldTime, oldTime);

    expect(() =>
      ProcessLock.acquire(tempDir, { timeoutMs: 200, retryIntervalMs: 25 })
    ).toThrow(/contains an invalid or foreign file\. Refusing to overwrite/);

    // User's foreign file MUST NOT be deleted
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(foreignContent);
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
