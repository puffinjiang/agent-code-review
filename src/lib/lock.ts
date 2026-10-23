import * as fs from "node:fs";
import * as path from "node:path";

export const LOCK_FILENAME = ".agent-code-review.lock";

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryIntervalMs?: number;
}

export class ProcessLock {
  public static getLockPath(baseDir: string): string {
    return path.join(baseDir, LOCK_FILENAME);
  }

  public static isPidAlive(pid: number): boolean {
    try {
      // Signal 0 tests for process existence without sending a signal
      process.kill(pid, 0);
      return true;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      return err.code === "EPERM"; // Process exists but different user
    }
  }

  public static acquire(baseDir: string, options: LockOptions = {}): () => void {
    const timeoutMs = options.timeoutMs ?? 5000;
    const staleMs = options.staleMs ?? 15000;
    const retryIntervalMs = options.retryIntervalMs ?? 50;

    const lockPath = this.getLockPath(baseDir);
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        // wx flag: open for writing, fails if path exists
        const fd = fs.openSync(lockPath, "wx", 0o600);
        const lockData = JSON.stringify({
          pid: process.pid,
          time: Date.now()
        });
        fs.writeSync(fd, lockData, 0, "utf-8");
        fs.closeSync(fd);

        // Lock acquired. Return release callback.
        return () => {
          try {
            if (fs.existsSync(lockPath)) {
              fs.unlinkSync(lockPath);
            }
          } catch {
            // Ignore unlock errors during cleanup
          }
        };
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === "EEXIST") {
          // Check for stale lock
          try {
            const stat = fs.statSync(lockPath);
            const age = Date.now() - stat.mtimeMs;
            let shouldBreakLock = age > staleMs;

            if (!shouldBreakLock) {
              try {
                const content = fs.readFileSync(lockPath, "utf-8");
                const data = JSON.parse(content);
                if (typeof data.pid === "number" && !this.isPidAlive(data.pid)) {
                  shouldBreakLock = true;
                }
              } catch {
                // Malformed lock file can be broken if older than 1s
                if (age > 1000) shouldBreakLock = true;
              }
            }

            if (shouldBreakLock) {
              try {
                fs.unlinkSync(lockPath);
                continue;
              } catch {
                // Another process might have cleaned it up
              }
            }
          } catch {
            // Stat failed, retry acquire in next tick
          }

          // Busy-wait wait with brief synchronous pause
          const waitEnd = Date.now() + retryIntervalMs;
          while (Date.now() < waitEnd) {
            // Brief spin wait to maintain synchronous execute() contract of Installer
          }
          continue;
        }

        // Other errors (e.g. ENOENT if baseDir doesn't exist yet)
        if (error.code === "ENOENT") {
          fs.mkdirSync(baseDir, { recursive: true });
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Failed to acquire lock on '${lockPath}' within ${timeoutMs}ms.`);
  }

  public static withLock<T>(baseDir: string, fn: () => T, options?: LockOptions): T {
    const release = this.acquire(baseDir, options);
    try {
      return fn();
    } finally {
      release();
    }
  }
}
