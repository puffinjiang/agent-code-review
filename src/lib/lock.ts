import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const LOCK_FILENAME = ".agent-code-review.lock";

export interface LockOptions {
  timeoutMs?: number;
  /** @deprecated 已升级为内核进程身份 (PID, startEpoch) 精确校验，不再依赖时间猜测 */
  staleMs?: number;
  retryIntervalMs?: number;
}

interface LockData {
  pid: number;
  token: string;
  time: number;
  startEpoch: number;
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
   * 本工具自身创建的锁必定包含数字 pid、UUID 字符串 token、数字 time 以及 startEpoch。
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
        return {
          pid: data.pid,
          token: data.token,
          time: data.time,
          startEpoch: typeof data.startEpoch === "number" ? data.startEpoch : data.time
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 获取目标 PID 的真实进程启动时刻（毫秒级 Epoch）。
   * - POSIX（macOS/Linux）：运行 `LC_ALL=C ps -o lstart= -p <pid>`，精度为秒级。
   * - Windows：运行 PowerShell 获取 StartTime。
   * 若进程不存在或查询失败，返回 null。
   */
  public static getProcessStartTime(pid: number): number | null {
    if (!this.isPidAlive(pid)) return null;

    if (process.platform === "win32") {
      try {
        const out = execFileSync(
          "powershell",
          ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToFileTimeUtc()`],
          { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 }
        ).trim();
        const fileTime = BigInt(out);
        const unixMs = Number((fileTime - 116444736000000000n) / 10000n);
        return isNaN(unixMs) ? null : unixMs;
      } catch {
        return null;
      }
    }

    try {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { ...process.env, LC_ALL: "C" },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500
      }).trim();
      const parsed = Date.parse(out);
      return isNaN(parsed) ? null : parsed;
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
    const retryIntervalMs = options.retryIntervalMs ?? 50;

    const lockPath = this.getLockPath(baseDir);
    const token = crypto.randomUUID();
    const startTime = Date.now();
    const startEpoch = Math.floor(Date.now() - process.uptime() * 1000);
    let notified = false;

    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

    while (Date.now() - startTime < timeoutMs) {
      this.lstatNoSymlink(lockPath);

      if (this.tryCreate(lockPath, { pid: process.pid, token, time: Date.now(), startEpoch })) {
        return () => this.release(lockPath, token);
      }

      // 锁已存在：进行进程身份精确校验与并发裁决
      const stat = this.lstatNoSymlink(lockPath);
      if (stat) {
        const data = this.readLock(lockPath);
        if (data) {
          const actualStartTime = this.getProcessStartTime(data.pid);
          if (actualStartTime === null) {
            // PID 已死（进程异常退出/崩溃残留）→ 确认为孤儿死锁，立即打破回收
            this.breakStale(lockPath, data.token);
            continue;
          }

          // PID 存活，进一步核验该 PID 的实际启动时刻与锁内 startEpoch 是否匹配（容差 ±2500ms）
          const timeDiff = Math.abs(actualStartTime - data.startEpoch);
          if (timeDiff > 2500) {
            // PID 存活但启动时刻不符（PID 被操作系统回收复用给无关进程，如 PID 1 或守护进程）→ 立即安全回收
            this.breakStale(lockPath, data.token);
            continue;
          }

          // PID 存活且启动时刻匹配 → 100% 确定为真实的并发 agent-code-review 活锁！
          // 绝不按 age 超时抢占活锁，避免破坏并发互斥。
          const elapsed = Date.now() - startTime;
          if (elapsed >= 300 && !notified) {
            notified = true;
            const heldSec = Math.max(1, Math.round((Date.now() - data.time) / 1000));
            process.stderr.write(
              `⏳ 检测到另一个 agent-code-review 正在运行 (PID: ${data.pid}, 已持锁 ${heldSec} 秒)\n` +
              `   锁路径: ${lockPath}\n`
            );
          }
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
