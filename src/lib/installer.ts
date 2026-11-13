import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getAdapter,
  PLATFORM_IDS,
  type PlatformId,
  type SupportedPlatform,
  type TemplateFile,
} from "../../adapters/index.js";
import { ProcessLock } from "./lock.js";
import { LEGACY_SHARED_CONFIG, resolveManagedPath } from "./managed-path.js";
import { type InstallationManifest, type ManifestFileEntry, ManifestManager } from "./manifest.js";
import { getPackageVersion } from "./version.js";

export type InstallScope = "global" | "local";

export interface InstallOptions {
  workspaceRoot?: string;
  homeDir?: string;
  scope?: InstallScope; // default: "global"
  platform?: SupportedPlatform; // default: "antigravity" or detected
  platforms?: PlatformId[]; // explicit platform subset
  /**
   * 仅更新现有安装：要求执行时已存在 installation manifest；
   * 若未显式指定 platform/platforms，则在锁内直接从 manifest.platforms 解析更新目标，
   * 消除前置检查与加锁执行之间的 TOCTOU 竞态。
   */
  updateExisting?: boolean;
  dryRun?: boolean;
  force?: boolean;
  templateDir?: string;
}

export type FileInstallAction = "create" | "update" | "skip-identical" | "conflict";

export interface InstallPlanItem {
  relativePath: string;
  platform: string;
  action: FileInstallAction;
  reason: string;
  sourceContent: string;
  hash: string;
}

export interface InstallResult {
  scope: InstallScope;
  baseDir: string;
  platforms: string[];
  success: boolean;
  dryRun: boolean;
  items: InstallPlanItem[];
  manifestSaved: boolean;
  alreadyUpToDate?: boolean;
  errors: string[];
}

export class Installer {
  private workspaceRoot: string;
  private homeDir: string;
  private scope: InstallScope;
  private platform: SupportedPlatform;
  private targetPlatforms: PlatformId[];
  private updateExisting: boolean;
  private useManifestPlatforms: boolean;
  private dryRun: boolean;
  private force: boolean;
  private templateDir?: string;

  constructor(options: InstallOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.homeDir = path.resolve(options.homeDir || os.homedir());
    this.scope = options.scope || "global"; // Global first by default!
    this.updateExisting = !!options.updateExisting;
    this.useManifestPlatforms =
      this.updateExisting && options.platform === undefined && options.platforms === undefined;
    if (options.platforms !== undefined) {
      if (options.platforms.length === 0) {
        throw new Error("Target platforms list cannot be empty.");
      }
      for (const p of options.platforms) {
        if (!(PLATFORM_IDS as readonly string[]).includes(p)) {
          throw new Error(`Unsupported platform: ${p}`);
        }
      }
      this.targetPlatforms = Array.from(new Set(options.platforms));
      this.platform =
        this.targetPlatforms.length === PLATFORM_IDS.length ? "all" : this.targetPlatforms[0];
    } else if (this.useManifestPlatforms) {
      this.platform = "all";
      this.targetPlatforms = [];
    } else {
      this.platform = options.platform || "antigravity";
      this.targetPlatforms =
        this.platform === "all" ? [...PLATFORM_IDS] : [this.platform as PlatformId];
    }
    this.dryRun = !!options.dryRun;
    this.force = !!options.force;
    this.templateDir = options.templateDir;
  }

  /**
   * N-1 / N-3: 原子替换写入。
   * 1. 先写入同目录随机临时文件，随后以原子 renameSync 替换，杜绝半截文件与截断风险；
   * 2. 若目标文件已存在，保留其原有 mode（文件权限，如 chmod 600），防止静默重置；
   * 3. 失败时自动清理临时文件。
   */
  public static writeAtomic(fullPath: string, content: string): void {
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    let existingMode: number | null = null;
    try {
      existingMode = fs.statSync(fullPath).mode;
    } catch {}

    const tmpPath = `${fullPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.writeFileSync(tmpPath, content, "utf-8");
      if (existingMode !== null) {
        try {
          fs.chmodSync(tmpPath, existingMode & 0o7777);
        } catch {}
      }
      fs.renameSync(tmpPath, fullPath);
    } catch (writeErr) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      throw writeErr;
    }
  }

  /**
   * 自动清理受管目录下的陈旧 .tmp. 孤儿文件（mtime > 1 小时，防止崩溃残留累积）。
   * 由 plan 的目标路径驱动，同时覆盖锁内幂等跳过（alreadyUpToDate）与写盘主流程。
   * 单遍 O(N) 路径归组，杜绝重复 resolveManagedPath 与文件系统扫描 (O-b)。
   */
  private purgeStaleTempFiles(baseDir: string, items: InstallPlanItem[]): void {
    const dirMap = new Map<string, Set<string>>();
    for (const item of items) {
      try {
        const fullPath = resolveManagedPath(baseDir, item.relativePath);
        const parentDir = path.dirname(fullPath);
        let baseNames = dirMap.get(parentDir);
        if (!baseNames) {
          baseNames = new Set<string>();
          dirMap.set(parentDir, baseNames);
        }
        baseNames.add(path.basename(item.relativePath));
      } catch {}
    }

    for (const [parentDir, managedBaseNames] of dirMap.entries()) {
      try {
        if (!fs.existsSync(parentDir)) continue;
        for (const file of fs.readdirSync(parentDir)) {
          for (const baseName of managedBaseNames) {
            if (file.startsWith(`${baseName}.tmp.`)) {
              const tmpFilePath = path.join(parentDir, file);
              try {
                const stat = fs.statSync(tmpFilePath);
                if (Date.now() - stat.mtimeMs > 3600_000) {
                  fs.unlinkSync(tmpFilePath);
                }
              } catch {}
              break;
            }
          }
        }
      } catch {}
    }
  }

  public getBaseDir(): string {
    return this.scope === "global" ? this.homeDir : this.workspaceRoot;
  }

  public static formatMissingInstallationError(scope: InstallScope, baseDir: string): string {
    const localFlag = scope === "local" ? " --local" : "";
    const otherScopeHint =
      scope === "global"
        ? " (or pass --local to update a workspace installation)"
        : " (or omit --local to update the global installation)";
    return `No ${scope} Agent Code Review installation found in ${baseDir}. Run 'npx agent-code-review init${localFlag}' first${otherScopeHint}.`;
  }

  public static getManifestSupportedPlatforms(manifest: InstallationManifest): PlatformId[] {
    return Array.from(
      new Set(
        manifest.platforms.filter((p): p is PlatformId =>
          (PLATFORM_IDS as readonly string[]).includes(p),
        ),
      ),
    );
  }

  private getTargetPlatforms(): PlatformId[] {
    return [...this.targetPlatforms];
  }

  private resolveTargetPlatformsForExecution(
    baseDir: string,
    existingManifest: InstallationManifest | null,
  ): PlatformId[] {
    if (this.updateExisting) {
      if (!existingManifest) {
        throw new Error(Installer.formatMissingInstallationError(this.scope, baseDir));
      }
      if (this.useManifestPlatforms) {
        const installed = Installer.getManifestSupportedPlatforms(existingManifest);
        if (installed.length === 0) {
          throw new Error(
            `Existing manifest in ${baseDir} does not record any supported platforms.`,
          );
        }
        return installed;
      }
    }
    return this.getTargetPlatforms();
  }

  public plan(): { items: InstallPlanItem[]; conflicts: string[] } {
    const baseDir = this.getBaseDir();
    return ProcessLock.withInspectionLock(baseDir, () => {
      const existingManifest = ManifestManager.load(baseDir);
      const targetPlatforms = this.resolveTargetPlatformsForExecution(baseDir, existingManifest);
      return this.planWithContext(baseDir, existingManifest, targetPlatforms);
    });
  }

  private planWithContext(
    baseDir: string,
    existingManifest: InstallationManifest | null,
    targetPlatforms: PlatformId[],
  ): { items: InstallPlanItem[]; conflicts: string[] } {
    const managedFilesMap = new Map<string, ManifestFileEntry>();

    if (existingManifest) {
      for (const entry of existingManifest.files) {
        managedFilesMap.set(entry.path, entry);
      }
    }

    const items: InstallPlanItem[] = [];
    const conflicts: string[] = [];

    for (const p of targetPlatforms) {
      const adapter = getAdapter(p);
      const templateFiles: TemplateFile[] = adapter.getTemplateFiles({
        templateRootDir: this.templateDir,
        isGlobal: this.scope === "global",
        homeDir: this.homeDir,
      });

      for (const tpl of templateFiles) {
        const fullDestPath = resolveManagedPath(baseDir, tpl.relativePath);
        const previous = managedFilesMap.get(tpl.relativePath);
        // Multiple platforms may share the same skill; install it only once.
        const planned = items.find((item) => item.relativePath === tpl.relativePath);
        if (planned) {
          if (planned.sourceContent !== tpl.sourceContent) {
            conflicts.push(tpl.relativePath);
          }
          continue;
        }
        const newHash = ManifestManager.computeHash(tpl.sourceContent);

        let existingStat: fs.Stats | null = null;
        try {
          existingStat = fs.lstatSync(fullDestPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }

        if (!existingStat) {
          items.push({
            relativePath: tpl.relativePath,
            platform: p,
            action: "create",
            reason: `New ${p} configuration file`,
            sourceContent: tpl.sourceContent,
            hash: newHash,
          });
        } else if (!existingStat.isFile()) {
          if (existingStat.isSymbolicLink()) {
            throw new Error(`Refusing symbolic link in managed path: ${tpl.relativePath}`);
          }
          items.push({
            relativePath: tpl.relativePath,
            platform: p,
            action: "conflict",
            reason:
              "Target path exists on disk as a directory or non-regular file; remove it manually before installing.",
            sourceContent: tpl.sourceContent,
            hash: newHash,
          });
          conflicts.push(tpl.relativePath);
        } else {
          const existingContent = fs.readFileSync(fullDestPath, "utf-8");
          const existingHash = ManifestManager.computeHash(existingContent);

          if (existingHash === newHash) {
            items.push({
              relativePath: tpl.relativePath,
              platform: p,
              action: "skip-identical",
              reason: "File already exists and content is identical",
              sourceContent: tpl.sourceContent,
              hash: newHash,
            });
          } else if (previous && (existingHash === previous.hash || this.force)) {
            items.push({
              relativePath: tpl.relativePath,
              platform: p,
              action: "update",
              reason: "Updating managed file from newer template",
              sourceContent: tpl.sourceContent,
              hash: newHash,
            });
          } else {
            // Unmanaged file conflict
            if (this.force) {
              items.push({
                relativePath: tpl.relativePath,
                platform: p,
                action: "update",
                reason: "Overwriting unmanaged file due to --force",
                sourceContent: tpl.sourceContent,
                hash: newHash,
              });
            } else {
              items.push({
                relativePath: tpl.relativePath,
                platform: p,
                action: "conflict",
                reason: previous
                  ? "Managed file has user edits; use --force to replace it."
                  : "Unmanaged file exists; use --force to replace it.",
                sourceContent: tpl.sourceContent,
                hash: newHash,
              });
              conflicts.push(tpl.relativePath);
            }
          }
        }
      }
    }

    return { items, conflicts };
  }

  public execute(): InstallResult {
    const baseDir = this.getBaseDir();

    if (this.dryRun) {
      let items: InstallPlanItem[];
      let conflicts: string[];
      let targetPlatforms = this.getTargetPlatforms();
      try {
        ({ items, conflicts, targetPlatforms } = ProcessLock.withInspectionLock(baseDir, () => {
          resolveManagedPath(baseDir, ".agent-code-review.json");
          const existingManifest = ManifestManager.load(baseDir);
          const resolvedPlatforms = this.resolveTargetPlatformsForExecution(
            baseDir,
            existingManifest,
          );
          const planned = this.planWithContext(baseDir, existingManifest, resolvedPlatforms);
          return { ...planned, targetPlatforms: resolvedPlatforms };
        }));
      } catch (error) {
        return {
          scope: this.scope,
          baseDir,
          platforms: targetPlatforms,
          success: false,
          dryRun: this.dryRun,
          items: [],
          manifestSaved: false,
          errors: [(error as Error).message],
        };
      }

      if (conflicts.length > 0) {
        return {
          scope: this.scope,
          baseDir,
          platforms: targetPlatforms,
          success: false,
          dryRun: this.dryRun,
          items,
          manifestSaved: false,
          errors: [
            `Installation aborted due to ${conflicts.length} conflicting file(s): ${conflicts.join(", ")}; shared configuration conflicts require manual resolution.`,
          ],
        };
      }

      return {
        scope: this.scope,
        baseDir,
        platforms: targetPlatforms,
        success: true,
        dryRun: true,
        items,
        manifestSaved: false,
        errors: [],
      };
    }

    // 加锁流程：进入独占排他锁，在锁内统一完成状态校验（alreadyUpToDate）与物理文件安装。
    // 不使用无锁快路径，防止并发安装写盘后失败回滚期间，无锁读者观察到未提交中间态并误报已最新。
    // 加锁失败、写盘失败、清单保存失败都统一转为结构化失败结果，不向 CLI 抛出未捕获异常。
    try {
      return this.executeLocked(baseDir);
    } catch (error) {
      return {
        scope: this.scope,
        baseDir,
        platforms: this.getTargetPlatforms(),
        success: false,
        dryRun: false,
        items: [],
        manifestSaved: false,
        errors: [(error as Error).message],
      };
    }
  }

  private executeLocked(baseDir: string): InstallResult {
    return ProcessLock.withLock(baseDir, () => {
      let existingManifest: InstallationManifest | null;
      let targetPlatforms = this.getTargetPlatforms();
      let items: InstallPlanItem[];
      let conflicts: string[];
      try {
        // C. 临界区内双重校验：在锁内重新加载清单并重新评估目标与 plan，
        // 纳入锁竞争期间其他进程已完成的修改或并发卸载。
        resolveManagedPath(baseDir, ".agent-code-review.json");
        existingManifest = ManifestManager.load(baseDir);
        targetPlatforms = this.resolveTargetPlatformsForExecution(baseDir, existingManifest);
        ({ items, conflicts } = this.planWithContext(baseDir, existingManifest, targetPlatforms));
      } catch (error) {
        return {
          scope: this.scope,
          baseDir,
          platforms: targetPlatforms,
          success: false,
          dryRun: false,
          items: [],
          manifestSaved: false,
          errors: [(error as Error).message],
        };
      }

      if (conflicts.length > 0) {
        return {
          scope: this.scope,
          baseDir,
          platforms: targetPlatforms,
          success: false,
          dryRun: false,
          items,
          manifestSaved: false,
          errors: [
            `Installation aborted due to ${conflicts.length} conflicting file(s): ${conflicts.join(", ")}; shared configuration conflicts require manual resolution.`,
          ],
        };
      }

      // 清理本次计划所涉及目录下的陈旧 .tmp. 遗留文件
      this.purgeStaleTempFiles(baseDir, items);

      // C. 临界区内幂等检查：若已有安装或等待锁期间其他进程已完成全部写入且 manifest 登记完整，无需重复写盘
      const currentVersion = getPackageVersion();
      const hasLegacyEntry = existingManifest?.files.some((f) => f.path === LEGACY_SHARED_CONFIG);
      const isVersionCurrent = existingManifest?.packageVersion === currentVersion;
      const allPlatformsCovered =
        existingManifest && targetPlatforms.every((p) => existingManifest.platforms.includes(p));
      const hasModifications = items.some((i) => i.action === "create" || i.action === "update");

      // BUG-2 修复：必须核对现有 manifest.files 是否真正登记了本次 plan 的全部文件且哈希一致
      const existingManifestMap = new Map(
        existingManifest?.files.map((f) => [f.path, f.hash]) || [],
      );
      const allFilesRegistered =
        items.length > 0 &&
        items.every((item) => existingManifestMap.get(item.relativePath) === item.hash);

      if (
        existingManifest &&
        !hasModifications &&
        !hasLegacyEntry &&
        !this.force &&
        allFilesRegistered &&
        allPlatformsCovered &&
        isVersionCurrent
      ) {
        // S-2 修复：已安装平台应取 manifest 的全集并集
        const combinedPlatforms = Array.from(
          new Set([...existingManifest.platforms, ...targetPlatforms]),
        );
        return {
          scope: this.scope,
          baseDir,
          platforms: combinedPlatforms,
          success: true,
          dryRun: false,
          items,
          manifestSaved: false,
          alreadyUpToDate: true,
          errors: [],
        };
      }

      const now = new Date().toISOString();
      const manifestFilesMap = new Map<string, ManifestFileEntry>();

      if (existingManifest) {
        for (const entry of existingManifest.files) {
          // 早期版本曾把用户的 .codex/config.toml 记入清单。现在 Codex 支持
          // agents 目录自动发现，注册块不再产生 —— 在下次安装时把这条记录退役，
          // 避免卸载时反复提示一个早已不再写入的路径。
          if (entry.path === LEGACY_SHARED_CONFIG) continue;
          manifestFilesMap.set(entry.path, entry);
        }
      }

      // V-11 修复：写入事务跟踪与中途失败原子回滚
      // 避免写中途失败（如 EACCES、磁盘已满）在磁盘上留下未入 manifest 的无主孤儿文件
      const newlyCreatedPaths: string[] = [];
      const previousFileContents = new Map<string, string>();

      try {
        for (const item of items) {
          const fullPath = resolveManagedPath(baseDir, item.relativePath);
          const parentDir = path.dirname(fullPath);

          if (item.action === "create" || item.action === "update") {
            if (!fs.existsSync(parentDir)) {
              fs.mkdirSync(parentDir, { recursive: true });
            }

            if (item.action === "update" && fs.existsSync(fullPath)) {
              previousFileContents.set(fullPath, fs.readFileSync(fullPath, "utf-8"));
            } else if (item.action === "create") {
              newlyCreatedPaths.push(fullPath);
            }

            Installer.writeAtomic(fullPath, item.sourceContent);
          }

          manifestFilesMap.set(item.relativePath, {
            path: item.relativePath,
            hash: item.hash,
            platform: item.platform,
            installedAt: now,
          });
        }

        const combinedPlatforms = Array.from(
          new Set([...(existingManifest?.platforms || []), ...targetPlatforms]),
        );

        const manifest: InstallationManifest = {
          schemaVersion: "1.0.0",
          packageVersion: getPackageVersion(),
          scope: this.scope,
          platforms: combinedPlatforms,
          installedAt: existingManifest?.installedAt || now,
          updatedAt: now,
          files: Array.from(manifestFilesMap.values()),
        };

        ManifestManager.save(baseDir, manifest);

        return {
          scope: this.scope,
          baseDir,
          platforms: combinedPlatforms,
          success: true,
          dryRun: false,
          items,
          manifestSaved: true,
          errors: [],
        };
      } catch (err: unknown) {
        // 回滚本次新创建的文件
        for (const createdPath of newlyCreatedPaths) {
          try {
            if (fs.existsSync(createdPath)) fs.unlinkSync(createdPath);
          } catch {
            // best effort cleanup
          }
        }
        // 恢复被更新文件的原始内容（走原子写入，防止回滚中断引发截断损坏）
        for (const [updatedPath, originalContent] of previousFileContents.entries()) {
          try {
            Installer.writeAtomic(updatedPath, originalContent);
          } catch {
            // best effort restore
          }
        }

        return {
          scope: this.scope,
          baseDir,
          platforms: targetPlatforms,
          success: false,
          dryRun: false,
          items,
          manifestSaved: false,
          errors: [
            `Installation failed during file write: ${(err as Error).message}. All partially written files have been rolled back.`,
          ],
        };
      }
    });
  }
}
