import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export const LOCK_FILENAME = ".agent-code-review.lock";

export interface LockOptions {
  timeoutMs?: number;
  retryIntervalMs?: number;
  staleMs?: number;
}

interface LockData {
  pid: number;
  token: string;
  time: number;
}

/**
 * 跨进程排他锁（轻量同步实现，保持 Installer/Uninstaller 的同步 execute() 契约）。
 *
 * 核心设计原则（回归常识与极简工程）：
 * 1. 临界区非常短：Installer 仅向本地磁盘写入 6 个 Markdown 模板与 1 个清单文件，正常耗时仅 20~50 毫秒。
 * 2. 原子互斥：使用 openSync(lockPath, "wx")，由操作系统内核保证 O_EXCL 原子排他。
 * 3. 拥有权校验：锁内包含唯一 UUID token，释放时仅在 token 匹配时才 unlink，防止误删他人新锁。
 * 4. 崩溃自愈：
 *    - 持锁进程已死亡（!isPidAlive）→ 立即自愈回收；
 *    - 锁年龄超过 MAX_LOCK_AGE_MS（默认 15 秒）→ 没有任何合法实例能运行 15 秒，即使 PID 碰巧被复用也确系崩溃残留，直接自愈回收；
 *    - 0 字节异常空文件持续超 500ms → 创建时崩溃残留，直接自愈回收；
 *    - 含有用户数据的非 ACR 外来文件 → 拒绝覆盖并报错，保护用户数据。
 * 5. 符号链接安全：遇到符号链接立即报错退出，绝不跟随。
 */
export class ProcessLock {
  public static readonly DEFAULT_TIMEOUT_MS = 5000;
  public static readonly DEFAULT_RETRY_INTERVAL_MS = 50;
  public static readonly DEFAULT_STALE_MS = 15000;

  public static getLockPath(baseDir: string): string {
    return path.join(baseDir, LOCK_FILENAME);
  }

  public static isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      return err.code === "EPERM"; // Process exists but belongs to a different user
    }
  }

  private static readLock(filePath: string): LockData | null {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (
        data &&
        typeof data === "object" &&
        Number.isInteger(data.pid) &&
        data.pid > 0 &&
        typeof data.token === "string" &&
        data.token.length > 0 &&
        typeof data.time === "number"
      ) {
        return {
          pid: data.pid,
          token: data.token,
          time: data.time
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private static sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  public static acquire(baseDir: string, options: LockOptions = {}): () => void {
    const timeoutMs = options.timeoutMs ?? this.DEFAULT_TIMEOUT_MS;
    const retryIntervalMs = options.retryIntervalMs ?? this.DEFAULT_RETRY_INTERVAL_MS;
    const maxAgeMs = options.staleMs ?? this.DEFAULT_STALE_MS;

    const lockPath = this.getLockPath(baseDir);
    const token = crypto.randomUUID();
    const startTime = Date.now();
    let notified = false;

    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

    while (Date.now() - startTime < timeoutMs) {
      // 1. 检查是否存在符号链接攻击
      try {
        const stat = fs.lstatSync(lockPath);
        if (stat.isSymbolicLink()) {
          throw new Error(`Refusing symbolic link at lock path: ${lockPath}`);
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      // 2. 尝试原子创建锁文件 (O_EXCL)
      let fd: number | null = null;
      try {
        fd = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, time: Date.now() }), "utf-8");
        return () => this.release(lockPath, token);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw err;
      } finally {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch {}
        }
      }

      // 3. 锁已存在：分析锁状态并尝试自愈
      try {
        const stat = fs.lstatSync(lockPath);
        if (stat.isSymbolicLink()) {
          throw new Error(`Refusing symbolic link at lock path: ${lockPath}`);
        }

        const age = Date.now() - stat.mtimeMs;
        const data = this.readLock(lockPath);

        if (!data) {
          // 无法解析：区分 0 字节崩溃残留 vs 外来文件
          if (stat.size === 0 && age > 500) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue;
          }
          if (stat.size > 0 && age > 500) {
            throw new Error(`Lock path '${lockPath}' contains an invalid or foreign file. Refusing to overwrite.`);
          }
        } else {
          // 合法锁数据
          // A. 进程已死亡（异常崩溃/强制退出）→ 立即自愈回收
          if (!this.isPidAlive(data.pid)) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue;
          }

          // B. 锁年龄超过 maxAgeMs（默认 15 秒）→ 本工具正常运行仅需几十毫秒，15秒后必定是崩溃残留
          // （即使该 PID 被操作系统复用给无关进程，也是死锁，必须安全自愈打破）
          if (age > maxAgeMs) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue;
          }

          // C. 真实并发冲突：若等待超过 300ms，在 stderr 打印友好提示
          const elapsed = Date.now() - startTime;
          if (elapsed >= 300 && !notified) {
            notified = true;
            const heldSec = Math.max(1, Math.round((Date.now() - data.time) / 1000));
            process.stderr.write(
              `⏳ 检测到另一个 agent-code-review 正在运行 (PID: ${data.pid}, 已持锁 ${heldSec} 秒)\n` +
              `   锁路径: ${lockPath}\n`
            );
          }
        }
      } catch (err: unknown) {
        if ((err as Error).message?.includes("Refusing") || (err as Error).message?.includes("foreign")) {
          throw err;
        }
      }

      this.sleepSync(retryIntervalMs);
    }

    const lastData = this.readLock(lockPath);
    const pidInfo = lastData ? `由正在运行的进程 (PID: ${lastData.pid}) 持有` : `被占用`;
    const inspectCmd = process.platform === "win32"
      ? (lastData ? `Get-Process -Id ${lastData.pid}` : `dir "${lockPath}"`)
      : (lastData ? `ps -p ${lastData.pid}` : `ls -l "${lockPath}"`);

    throw new Error(
      `获取安装锁超时 (${timeoutMs}ms)：该锁${pidInfo}。\n` +
      `   锁路径: ${lockPath}\n` +
      `   可运行 '${inspectCmd}' 查看该进程状态。\n` +
      `   若确认该进程已异常退出，下次运行本工具时会自动安全回收锁。`
    );
  }

  public static release(lockPath: string, token: string): void {
    try {
      const stat = fs.lstatSync(lockPath);
      if (stat.isSymbolicLink()) return;

      const current = this.readLock(lockPath);
      if (current && current.token === token) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // 锁已被移除或不可访问
    }
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
