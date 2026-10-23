import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ProcessLock } from "../src/lib/lock.js";

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

  it("should correctly check current process pid as alive", () => {
    expect(ProcessLock.isPidAlive(process.pid)).toBe(true);
    // Non-existent PID
    expect(ProcessLock.isPidAlive(999999999)).toBe(false);
  });

  it("should break dead pid lock automatically", () => {
    const lockPath = ProcessLock.getLockPath(tempDir);
    // Write a lockfile with dead PID
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
});
