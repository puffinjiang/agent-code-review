import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export const LOCK_FILENAME = ".agent-code-review.lock";

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryIntervalMs?: number;
}

interface LockData {
  pid: number;
  token: string;
  time: number;
}

/**
 * 跨进程排他锁（同步实现，以保持 Installer/Uninstaller 的同步 execute() 契约）。
 *
 * 设计约束（见 docs/audit-and-remediation.md D-14）：
 * 1. 原子初始化：先把完整内容写入随机命名的临时文件，再 linkSync 发布到锁路径。
 *    link 在目标已存在（含符号链接）时以 EEXIST 失败，锁文件永远不会以 0 字节形态被他人观察到。
 * 2. 所有权释放：每次加锁生成唯一 token，release() 仅在锁文件 token 仍属于自己时才删除。
 * 3. 原子破锁：过期锁先 rename 到唯一回收路径（同一文件只有一个进程能 rename 成功），
 *    再核对 token；若误移了他人刚创建的新锁，则尝试 link 回原处。
 * 4. 拒绝符号链接：锁路径为符号链接时立即失败，不跟随、不忙等。
 */
export class ProcessLock {
  public static getLockPath(baseDir: string): string {
    return path.join(baseDir, LOCK_FILENAME);
  }

  public static isPidAlive(pid: number): boolean {
    // kill(0) 指向当前进程组、kill(负数) 指向进程组/全部进程，均会"成功"，必须排除
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      // Signal 0 tests for process existence without sending a signal
      process.kill(pid, 0);
      return true;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      return err.code === "EPERM"; // Process exists but belongs to a different user
    }
  }

  private static uniqueSibling(lockPath: string, kind: string): string {
    return `${lockPath}.${kind}.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  }

  /**
   * V-6 完整修复：严格校验 ACR 锁格式。
   * 本工具自身创建的锁必定包含数字 pid、UUID 字符串 token 以及数字 time。
   * 任何缺少这些字段的 JSON（例如用户的自定义配置或仅含 pid 的外来数据）均视为非锁文件，防止被误判为孤立锁删除。
   */
  private static readLock(filePath: string): LockData | null {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (
        data &&
        typeof data === "object" &&
        typeof data.pid === "number" &&
        typeof data.token === "string" &&
        data.token.length > 0 &&
        typeof data.time === "number"
      ) {
        return data as LockData;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 拒绝符号链接；返回 lstat 结果，路径不存在时返回 null。 */
  private static lstatNoSymlink(lockPath: string): fs.Stats | null {
    try {
      const stat = fs.lstatSync(lockPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link at lock path: ${lockPath}`);
      }
      return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** 以「临时文件 + link」原子创建锁文件。成功返回 true，锁已存在返回 false。 */
  private static tryCreate(lockPath: string, data: LockData): boolean {
    const tmpPath = this.uniqueSibling(lockPath, "tmp");
    const fd = fs.openSync(tmpPath, "wx", 0o600);
    try {
      try {
        fs.writeFileSync(fd, JSON.stringify(data), "utf-8");
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.linkSync(tmpPath, lockPath);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return false;
        // 不支持硬链接的文件系统：退化为 O_EXCL 直接创建（仍保证互斥，只是存在极短的空文件窗口）
        if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS") {
          return this.tryCreateExclusive(lockPath, data);
        }
        throw error;
      }
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    }
  }

  private static tryCreateExclusive(lockPath: string, data: LockData): boolean {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(data), "utf-8");
    } catch (error) {
      fs.closeSync(fd);
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      throw error;
    }
    fs.closeSync(fd);
    return true;
  }

  /**
   * 原子地打破一个被判定为过期的锁。
   * expectedToken 为判定时读到的 token。
   */
  private static breakStale(lockPath: string, expectedToken: string): void {
    const trashPath = this.uniqueSibling(lockPath, "stale");
    try {
      fs.renameSync(lockPath, trashPath);
    } catch (error) {
      // ENOENT：已被其他破锁者移走，直接重试获取即可
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const moved = this.readLock(trashPath);
    const movedToken = moved?.token ?? null;
    if (movedToken !== expectedToken) {
      // 判定与 rename 之间锁已被他人替换：我们误移了一个新的活锁，尽力恢复
      try {
        fs.renameSync(trashPath, lockPath);
      } catch {
        // V-3 修复：原处已有新锁占用，保留 trashPath 绝不强行 unlink 他人的有效锁
        return;
      }
    }
    try { fs.unlinkSync(trashPath); } catch { /* ignore */ }
  }

  private static sleepSync(ms: number): void {
    // 同步等待，保持 Installer.execute() 的同步契约且不占用 CPU
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  public static acquire(baseDir: string, options: LockOptions = {}): () => void {
    const timeoutMs = options.timeoutMs ?? 5000;
    const staleMs = options.staleMs ?? 15000;
    const retryIntervalMs = options.retryIntervalMs ?? 50;

    const lockPath = this.getLockPath(baseDir);
    const token = crypto.randomUUID();
    const startTime = Date.now();

    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

    while (Date.now() - startTime < timeoutMs) {
      this.lstatNoSymlink(lockPath);

      if (this.tryCreate(lockPath, { pid: process.pid, token, time: Date.now() })) {
        // 启动心跳刷新锁 mtime，确保当前存活进程持锁期间 age 绝不超期 (V-1 & V-2)
        const heartbeatInterval = Math.max(50, Math.min(1000, Math.floor(staleMs / 3)));
        const timer = setInterval(() => {
          try {
            const current = this.readLock(lockPath);
            if (current && current.token === token) {
              const now = new Date();
              fs.utimesSync(lockPath, now, now);
            }
          } catch {
            // ignore
          }
        }, heartbeatInterval);
        if (timer.unref) timer.unref();

        return () => {
          clearInterval(timer);
          this.release(lockPath, token);
        };
      }

      // 锁已存在：判断是否过期
      const stat = this.lstatNoSymlink(lockPath);
      if (stat) {
        const data = this.readLock(lockPath);
        if (data) {
          const age = Date.now() - stat.mtimeMs;
          const isAlive = this.isPidAlive(data.pid);
          // 破锁条件：
          // 1. 持锁进程已死亡（!isAlive）：属于孤立崩溃残留，立即破锁；
          // 2. 或 age > staleMs：即使持锁 pid 似乎存活（如 pid 被系统复用给了 pid 1 或无关进程），
          //    但由于心跳早已中断（age 超过设定过期时间），证明原任务早已退出或废弃，作为兜底破锁。
          const isStale = !isAlive || age > staleMs;
          if (isStale) {
            this.breakStale(lockPath, data.token);
            continue;
          }
          // 否则：持锁进程存活且心跳正常（age <= staleMs），为有效活锁，等待释放
        } else {
          // V-6 修复：非 ACR 锁结构的文件（外来文件或用户自定义文件），绝不能判定为 stale 并无条件删除
          // 若文件刚被创建（age <= 500ms），可能处于原子写入的极短过渡期，给予重试机会；
          // 超过 500ms 仍无法解析为有效 ACR 锁，判定为外来文件冲突，立即拒绝并报错保护用户数据。
          const age = Date.now() - stat.mtimeMs;
          if (age > 500) {
            throw new Error(`Lock path '${lockPath}' contains an invalid or foreign file. Refusing to overwrite.`);
          }
        }
      }

      this.sleepSync(retryIntervalMs);
    }

    throw new Error(`Failed to acquire lock on '${lockPath}' within ${timeoutMs}ms.`);
  }

  /**
   * V-2 修复：以原子方式释放锁，消除 token 校验与 unlink 分离产生的 TOCTOU 竞态。
   * 先原子 rename 至独占回收路径断开 lockPath 引用，核验 token 属于自己后再删除；
   * 若窗口内已由他人破锁或更替，将移走的锁文件还原，绝不误删他人的有效锁。
   */
  private static release(lockPath: string, token: string): void {
    const trashPath = this.uniqueSibling(lockPath, "release");
    try {
      const stat = fs.lstatSync(lockPath);
      if (stat.isSymbolicLink()) return;

      const current = this.readLock(lockPath);
      if (!current || current.token !== token) return;

      fs.renameSync(lockPath, trashPath);
    } catch {
      // 锁已被删除或不可访问，无需释放
      return;
    }

    try {
      const moved = this.readLock(trashPath);
      if (moved && moved.token === token) {
        try { fs.unlinkSync(trashPath); } catch { /* ignore */ }
      } else {
        // 极短窗口内移走的是他人的新锁：原子移回恢复
        try {
          fs.renameSync(trashPath, lockPath);
        } catch {
          // V-3 修复：恢复失败（原处已有新锁），保留 trashPath 绝不强行删除他人有效锁
        }
      }
    } catch {
      // 保护性捕获：绝不误删未核验 token 的文件
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
