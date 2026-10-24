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
  /** 旧格式或手工写入的锁文件可能缺少 token */
  token?: string;
  time?: number;
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

  private static readLock(filePath: string): LockData | null {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (data && typeof data.pid === "number") return data as LockData;
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
   * expectedToken 为判定时读到的 token（损坏的锁文件为 null）。
   */
  private static breakStale(lockPath: string, expectedToken: string | null): void {
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
      try { fs.linkSync(trashPath, lockPath); } catch { /* 已有更新的锁，放弃恢复 */ }
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
        return () => this.release(lockPath, token);
      }

      // 锁已存在：判断是否过期
      const stat = this.lstatNoSymlink(lockPath);
      if (stat) {
        const data = this.readLock(lockPath);
        if (data && typeof data.pid === "number") {
          // V-1 修复：只要持锁者 PID 依然存活，绝不能仅凭 age 过期破锁（防止活锁被抢占导致并发写入冲突）
          if (!this.isPidAlive(data.pid)) {
            // 持有者进程已死亡，确认为孤立死锁，安全破锁
            this.breakStale(lockPath, data.token ?? null);
            continue;
          }
          // 持有者进程仍然存活：互斥生效，等待持有者释放
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
          try { fs.unlinkSync(trashPath); } catch { /* ignore */ }
        }
      }
    } catch {
      try { fs.unlinkSync(trashPath); } catch { /* ignore */ }
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
