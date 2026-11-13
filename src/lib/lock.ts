import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const LOCK_FILENAME = ".agent-code-review.lock";
const OWNER_FILE_PREFIX = "owner-";
const OWNER_FILE_SUFFIX = ".json";

export interface LockOptions {
  timeoutMs?: number;
  retryIntervalMs?: number;
  /**
   * @deprecated 已取消“仅凭年龄抢占活进程”策略；仅保留字段以兼容既有调用方类型。
   */
  staleMs?: number;
}

interface LockData {
  pid: number;
  token: string;
  time: number;
}

interface LockIdentity {
  dev: number;
  ino: number;
}

interface OpenedLockFile {
  fd: number;
  stat: fs.Stats;
  data: LockData | null;
  identity: LockIdentity;
}

/**
 * 跨进程排他锁（零外部依赖纯 node:fs 目录锁实现，保持同步 execute() 契约）。
 *
 * 核心设计原则：
 * 1. 原子发布：先在同目录临时目录写入 `owner-<token>.json`，再通过 `renameSync(tmpDir, lockPath)`
 *    原子发布整棵锁目录，锁目录自可见时刻起即完整包含持有者凭据，永不出现空目录竞争窗口。
 * 2. 原子释放与回收：
 *    - 仅以精确凭据文件名 `owner-<token>.json` 执行 `unlinkSync`，随后再执行非递归 `rmdirSync(lockPath)`。
 *    - 即使在检查与 `unlinkSync` 之间发生线程抢占且路径已被新持有者替换，由于新锁使用新 UUID
 *      文件名 `owner-<newToken>.json`，旧持有者或落败回收方的 `unlinkSync` 只会命中 `ENOENT` 并立即退出，
 *      不会删除新锁，也不会调用 `rmdirSync`。
 *    - 即使在 `unlinkSync(owner-<oldToken>.json)` 与 `rmdirSync(lockPath)` 之间被新持有者替换，
 *      操作系统内核保证非递归 `rmdirSync` 对非空目录返回 `ENOTEMPTY`/`EEXIST`，新锁绝对安全。
 * 3. 活性策略：
 *    - 持锁进程已死亡（`!isPidAlive(pid)`）→ 立即安全回收；
 *    - 持锁进程仍存活（`isPidAlive(pid)`）→ 绝不因时间阈值抢占活进程锁，等待释放或超时报错。
 * 4. 外来数据与符号链接安全：结合 `lstatSync`、`O_NOFOLLOW` 与单文件/非空外来目录检查，
 *    拒绝跟随符号链接并拒绝覆盖外来文件或外来目录。
 */
export class ProcessLock {
  public static readonly DEFAULT_TIMEOUT_MS = 5000;
  public static readonly DEFAULT_RETRY_INTERVAL_MS = 50;
  private static readonly O_SAFE_READ =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

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

  private static ownerFileName(token: string): string {
    if (!token || token === "." || token === ".." || /[/\\]/.test(token)) {
      throw new Error("Invalid lock token format.");
    }
    return `${OWNER_FILE_PREFIX}${token}${OWNER_FILE_SUFFIX}`;
  }

  private static safeOwnerFileName(token: string): string | null {
    try {
      return this.ownerFileName(token);
    } catch {
      return null;
    }
  }

  private static isOwnerFileName(name: string): boolean {
    return (
      name.startsWith(OWNER_FILE_PREFIX) &&
      name.endsWith(OWNER_FILE_SUFFIX) &&
      name.length > OWNER_FILE_PREFIX.length + OWNER_FILE_SUFFIX.length
    );
  }

  private static sameFileIdentity(a: fs.Stats | LockIdentity, b: fs.Stats | LockIdentity): boolean {
    return a.dev === b.dev && a.ino === b.ino;
  }

  private static isSymlinkOpenError(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === "ELOOP" || code === "EMLINK";
  }

  private static pathExistsViaLstat(targetPath: string): boolean {
    try {
      fs.lstatSync(targetPath);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return false;
      }
      return true;
    }
  }

  private static isDirectoryWritable(dirPath: string): boolean {
    try {
      fs.accessSync(dirPath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private static parseLockContent(content: string): LockData | null {
    try {
      const data = JSON.parse(content);
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
          time: data.time,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private static createPermissionError(targetPath: string, code: string, isDir = false): Error {
    const label = isDir ? "安装锁目录" : "安装锁文件";
    const rmCmd = isDir ? `rm -rf "${targetPath}"` : `rm "${targetPath}"`;
    return Object.assign(
      new Error(
        `无法读取${label}（权限不足/${code}）: ${targetPath}\n` +
          `   若确认该锁残留无用，可使用更高权限删除后重试: ${rmCmd}`,
      ),
      { code },
    );
  }

  /**
   * 通过 O_NOFOLLOW 打开文件并同时绑定 fstat 与内容，避免 stat 与 read 错配或跟随符号链接。
   */
  private static readOpenedLock(filePath: string): OpenedLockFile | null {
    try {
      const lstat = fs.lstatSync(filePath);
      if (lstat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link at lock path: ${filePath}`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    let fd: number;
    try {
      fd = fs.openSync(filePath, this.O_SAFE_READ);
    } catch (openErr: unknown) {
      const code = (openErr as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (this.isSymlinkOpenError(openErr)) {
        throw new Error(`Refusing symbolic link at lock path: ${filePath}`);
      }
      if (code === "EACCES" || code === "EPERM") {
        throw this.createPermissionError(filePath, code);
      }
      throw openErr;
    }

    try {
      const stat = fs.fstatSync(fd);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link at lock path: ${filePath}`);
      }
      if (!stat.isFile()) {
        throw new Error(
          `Lock path '${filePath}' exists on disk as a directory or non-regular file. Refusing to overwrite.`,
        );
      }
      const content = fs.readFileSync(fd, "utf-8");
      const data = this.parseLockContent(content);
      return {
        fd,
        stat,
        data,
        identity: { dev: stat.dev, ino: stat.ino },
      };
    } catch (readErr: unknown) {
      try {
        fs.closeSync(fd);
      } catch {}
      const code = (readErr as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        throw this.createPermissionError(filePath, code);
      }
      throw readErr;
    }
  }

  private static sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  /**
   * 临时目录 + `owner-<token>.json` 写完后，通过 `renameSync(tmpDir, lockPath)` 原子发布锁目录。
   */
  private static tryCreate(lockPath: string, data: LockData): LockIdentity | null {
    const tmpDir = `${lockPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
    const ownerFile = this.ownerFileName(data.token);
    const tmpOwnerPath = path.join(tmpDir, ownerFile);
    let fd: number | null = null;
    let tmpDirCreated = false;
    let tmpOwnerCreated = false;
    let renamed = false;

    try {
      fs.mkdirSync(tmpDir, { mode: 0o700 });
      tmpDirCreated = true;

      fd = fs.openSync(tmpOwnerPath, "wx", 0o600);
      tmpOwnerCreated = true;
      fs.writeFileSync(fd, JSON.stringify(data), "utf-8");
      const stat = fs.fstatSync(fd);
      const identity: LockIdentity = { dev: stat.dev, ino: stat.ino };
      fs.closeSync(fd);
      fd = null;

      try {
        fs.renameSync(tmpDir, lockPath);
        renamed = true;
        return identity;
      } catch (renameErr: unknown) {
        const code = (renameErr as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") {
          return null;
        }
        // Windows MoveFileExW 对已存在目录/文件可能返回 EPERM 或 EACCES；确认目标确实存在则视作正常锁竞争
        if ((code === "EPERM" || code === "EACCES") && this.pathExistsViaLstat(lockPath)) {
          return null;
        }
        throw renameErr;
      }
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      if (!renamed) {
        if (tmpOwnerCreated) {
          try {
            fs.unlinkSync(tmpOwnerPath);
          } catch {}
        }
        if (tmpDirCreated) {
          try {
            fs.rmdirSync(tmpDir);
          } catch {}
        }
      }
    }
  }

  private static tryRmdirIfEmpty(dirPath: string): void {
    try {
      const stat = fs.lstatSync(dirPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      fs.rmdirSync(dirPath);
    } catch {
      // ENOENT / ENOTEMPTY / EEXIST / ENOTDIR / EPERM / EACCES: 安全忽略
    }
  }

  private static unlinkLegacyFileIfVerified(
    lockPath: string,
    expectedToken: string | null,
    expectedIdentity?: LockIdentity,
  ): void {
    const preStat = fs.lstatSync(lockPath);
    if (preStat.isSymbolicLink() || !preStat.isFile()) return;
    if (
      expectedIdentity &&
      expectedIdentity.ino > 0 &&
      !this.sameFileIdentity(preStat, expectedIdentity)
    ) {
      return;
    }

    const opened = this.readOpenedLock(lockPath);
    if (!opened) return;

    try {
      if (
        expectedIdentity &&
        expectedIdentity.ino > 0 &&
        !this.sameFileIdentity(opened.stat, expectedIdentity)
      ) {
        return;
      }
      const matches =
        expectedToken === null
          ? opened.stat.size === 0
          : opened.data !== null && opened.data.token === expectedToken;
      if (!matches) return;

      const confirmStat = fs.lstatSync(lockPath);
      if (confirmStat.isSymbolicLink() || !confirmStat.isFile()) return;
      const sameTarget =
        opened.stat.ino > 0
          ? this.sameFileIdentity(confirmStat, opened.stat)
          : confirmStat.size === opened.stat.size && confirmStat.mtimeMs === opened.stat.mtimeMs;
      if (!sameTarget) return;

      fs.unlinkSync(lockPath);
    } finally {
      try {
        fs.closeSync(opened.fd);
      } catch {}
    }
  }

  /**
   * 按凭据文件名 `owner-<token>.json` 执行精准 `unlinkSync`，随后才执行非递归 `rmdirSync`。
   */
  private static releaseOwnerEntry(
    lockPath: string,
    expectedFileName: string,
    expectedToken: string | null,
    expectedIdentity?: LockIdentity,
  ): void {
    const dirStat = fs.lstatSync(lockPath);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return;

    const ownerPath = path.join(lockPath, expectedFileName);
    const opened = this.readOpenedLock(ownerPath);
    if (!opened) return;

    let shouldUnlink = false;
    try {
      const currentDirStat = fs.lstatSync(lockPath);
      if (currentDirStat.isSymbolicLink() || !currentDirStat.isDirectory()) return;

      if (
        expectedIdentity &&
        expectedIdentity.ino > 0 &&
        !this.sameFileIdentity(opened.stat, expectedIdentity)
      ) {
        return;
      }
      shouldUnlink =
        expectedToken === null
          ? opened.stat.size === 0
          : opened.data !== null && opened.data.token === expectedToken;
    } finally {
      try {
        fs.closeSync(opened.fd);
      } catch {}
    }

    if (!shouldUnlink) return;

    const latestDirStat = fs.lstatSync(lockPath);
    if (latestDirStat.isSymbolicLink() || !latestDirStat.isDirectory()) return;

    try {
      fs.unlinkSync(ownerPath);
    } catch (unlinkErr: unknown) {
      const code = (unlinkErr as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // 锁目录已被其他持有者替换或已被他人先行回收/释放，绝不继续执行 rmdirSync
        return;
      }
      throw unlinkErr;
    }

    this.tryRmdirIfEmpty(lockPath);
  }

  /**
   * 在不跟随符号链接的前提下安全回收已死亡进程的锁定残留或空目录残留。
   * 仅匹配 `expectedToken` 对应的 `owner-<token>.json` 后执行 `unlinkSync` 与非递归 `rmdirSync`，
   * 绝不会删除新持有者的锁目录或外来文件。
   */
  private static reclaim(
    lockPath: string,
    expectedToken: string | null,
    expectedIdentity?: LockIdentity,
  ): void {
    try {
      const preStat = fs.lstatSync(lockPath);
      if (preStat.isSymbolicLink() || !preStat.isDirectory()) return;

      if (expectedToken === null) {
        const entries = fs.readdirSync(lockPath);
        if (entries.length === 0) {
          this.tryRmdirIfEmpty(lockPath);
        } else if (entries.length === 1 && this.isOwnerFileName(entries[0])) {
          this.releaseOwnerEntry(lockPath, entries[0], null, expectedIdentity);
        }
        return;
      }

      this.releaseOwnerEntry(
        lockPath,
        this.ownerFileName(expectedToken),
        expectedToken,
        expectedIdentity,
      );
    } catch {
      // ENOENT / ENOTDIR / 并发抢占回收失败：忽略并留待下一轮检查
    }
  }

  private static notifyContention(
    lockPath: string,
    data: LockData,
    startTime: number,
    notified: boolean,
  ): boolean {
    if (notified || Date.now() - startTime < 300) return notified;
    const heldSec = Math.max(1, Math.round((Date.now() - data.time) / 1000));
    process.stderr.write(
      `⏳ 检测到另一个 agent-code-review 正在运行 (PID: ${data.pid}, 已持锁 ${heldSec} 秒)\n` +
        `   锁路径: ${lockPath}\n`,
    );
    return true;
  }

  private static inspectAndHandleExistingLock(
    lockPath: string,
    startTime: number,
    notified: boolean,
  ): { retryImmediately: boolean; notified: boolean } {
    let existingStat: fs.Stats;
    try {
      existingStat = fs.lstatSync(lockPath);
    } catch (lstatErr: unknown) {
      if ((lstatErr as NodeJS.ErrnoException).code === "ENOENT") {
        return { retryImmediately: true, notified };
      }
      throw lstatErr;
    }

    if (existingStat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link at lock path: ${lockPath}`);
    }

    if (existingStat.isFile()) {
      // 兼容历史单文件格式与外来文件保护：非本工具格式坚决拒绝覆盖；已死亡或遗留空文件安全清理
      const opened = this.readOpenedLock(lockPath);
      if (!opened) return { retryImmediately: true, notified };
      try {
        const { stat, data, identity } = opened;
        const age = Date.now() - stat.mtimeMs;
        if (!data) {
          if (stat.size === 0 && age > 500) {
            this.unlinkLegacyFileIfVerified(lockPath, null, identity);
            return { retryImmediately: true, notified };
          }
          if (stat.size > 0) {
            throw new Error(
              `Lock path '${lockPath}' contains an invalid or foreign file. Refusing to overwrite.\n` +
                `   若确认为本工具遗留的残留，可删除后重试: rm "${lockPath}"`,
            );
          }
          return { retryImmediately: false, notified };
        }
        if (!this.isPidAlive(data.pid)) {
          this.unlinkLegacyFileIfVerified(lockPath, data.token, identity);
          return { retryImmediately: true, notified };
        }
        return {
          retryImmediately: false,
          notified: this.notifyContention(lockPath, data, startTime, notified),
        };
      } finally {
        try {
          fs.closeSync(opened.fd);
        } catch {}
      }
    }

    if (!existingStat.isDirectory()) {
      throw new Error(
        `Lock path '${lockPath}' exists on disk as an invalid non-directory entry. Refusing to overwrite.`,
      );
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(lockPath);
    } catch (readDirErr: unknown) {
      const code = (readDirErr as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { retryImmediately: true, notified };
      }
      if (code === "EACCES" || code === "EPERM") {
        throw this.createPermissionError(lockPath, code, true);
      }
      throw readDirErr;
    }

    if (entries.length === 0) {
      this.tryRmdirIfEmpty(lockPath);
      return { retryImmediately: true, notified };
    }

    if (entries.length !== 1 || !this.isOwnerFileName(entries[0])) {
      throw new Error(
        `Lock path '${lockPath}' contains an invalid or foreign directory. Refusing to overwrite.\n` +
          `   请手动确认并移走该目录下的非本工具文件后重试。`,
      );
    }

    const ownerFile = entries[0];
    const opened = this.readOpenedLock(path.join(lockPath, ownerFile));
    if (!opened) return { retryImmediately: true, notified };
    try {
      const { stat, data, identity } = opened;
      const validData = data && this.safeOwnerFileName(data.token) === ownerFile ? data : null;
      const age = Date.now() - stat.mtimeMs;

      if (!validData) {
        if (stat.size === 0 && age > 500) {
          this.releaseOwnerEntry(lockPath, ownerFile, null, identity);
          return { retryImmediately: true, notified };
        }
        if (stat.size > 0 || data !== null) {
          throw new Error(
            `Lock path '${lockPath}' contains an invalid or foreign file. Refusing to overwrite.\n` +
              `   若确认为本工具遗留的残留，可确认安全后删除重试: rm -rf "${lockPath}"`,
          );
        }
        return { retryImmediately: false, notified };
      }

      if (!this.isPidAlive(validData.pid)) {
        this.reclaim(lockPath, validData.token, identity);
        return { retryImmediately: true, notified };
      }

      return {
        retryImmediately: false,
        notified: this.notifyContention(lockPath, validData, startTime, notified),
      };
    } finally {
      try {
        fs.closeSync(opened.fd);
      } catch {}
    }
  }

  private static inspectDiagnosticData(lockPath: string): LockData | null {
    try {
      const stat = fs.lstatSync(lockPath);
      if (stat.isSymbolicLink()) return null;
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(lockPath);
        if (entries.length !== 1 || !this.isOwnerFileName(entries[0])) return null;
        const opened = this.readOpenedLock(path.join(lockPath, entries[0]));
        if (!opened) return null;
        try {
          if (opened.data && this.safeOwnerFileName(opened.data.token) === entries[0]) {
            return opened.data;
          }
          return null;
        } finally {
          try {
            fs.closeSync(opened.fd);
          } catch {}
        }
      }
      if (stat.isFile()) {
        const opened = this.readOpenedLock(lockPath);
        if (!opened) return null;
        try {
          return opened.data;
        } finally {
          try {
            fs.closeSync(opened.fd);
          } catch {}
        }
      }
    } catch {
      // 忽略超时诊断阶段的读取异常，降级显示通用被占用提示
    }
    return null;
  }

  public static acquire(baseDir: string, options: LockOptions = {}): () => void {
    const timeoutMs = options.timeoutMs ?? this.DEFAULT_TIMEOUT_MS;
    const retryIntervalMs = options.retryIntervalMs ?? this.DEFAULT_RETRY_INTERVAL_MS;

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

      // 2. 尝试原子发布目录锁（临时目录预写入 owner-<token>.json 后 renameSync）
      try {
        const identity = this.tryCreate(lockPath, { pid: process.pid, token, time: Date.now() });
        if (identity) {
          return () => this.release(lockPath, token, identity);
        }
      } catch (err: unknown) {
        throw new Error(`获取安装锁失败: ${(err as Error).message}`);
      }

      // 3. 锁已存在：检查目录/遗留文件状态并在仅限死亡进程时安全回收
      try {
        const outcome = this.inspectAndHandleExistingLock(lockPath, startTime, notified);
        notified = outcome.notified;
        if (outcome.retryImmediately) {
          continue;
        }
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          continue;
        }
        throw err;
      }

      this.sleepSync(retryIntervalMs);
    }

    const lastData = this.inspectDiagnosticData(lockPath);
    const pidInfo = lastData ? `由正在运行的进程 (PID: ${lastData.pid}) 持有` : `被占用`;
    const inspectCmd =
      process.platform === "win32"
        ? lastData
          ? `Get-Process -Id ${lastData.pid}`
          : `dir "${lockPath}"`
        : lastData
          ? `ps -p ${lastData.pid}`
          : `ls -la "${lockPath}"`;

    throw new Error(
      `获取安装锁超时 (${timeoutMs}ms)：该锁${pidInfo}。\n` +
        `   锁路径: ${lockPath}\n` +
        `   可运行 '${inspectCmd}' 查看该进程状态。\n` +
        `   若确认该进程已异常退出，下次运行本工具时会自动安全回收锁。`,
    );
  }

  public static release(lockPath: string, token: string, heldIdentity?: LockIdentity): void {
    try {
      this.releaseOwnerEntry(lockPath, this.ownerFileName(token), token, heldIdentity);
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

  /**
   * 为只读校验/诊断/预览路径提供与安装和卸载同一把 `ProcessLock` 串行保护：
   * 若目标目录存在且可写（或已存在 `.agent-code-review.lock`），必须获取同一把锁后再读取校验；
   * 若目标目录尚不存在或处于无锁的只读目录（如 `cwd` 为 `/`），则避免创建目录或误报权限失败。
   */
  public static withInspectionLock<T>(baseDir: string, fn: () => T, options?: LockOptions): T {
    const resolvedDir = path.resolve(baseDir);
    if (!fs.existsSync(resolvedDir)) {
      return fn();
    }
    const lockExists = this.pathExistsViaLstat(this.getLockPath(resolvedDir));
    if (lockExists || this.isDirectoryWritable(resolvedDir)) {
      return this.withLock(resolvedDir, fn, options);
    }
    return fn();
  }
}
