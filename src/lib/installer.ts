import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ManifestManager, InstallationManifest, ManifestFileEntry } from "./manifest.js";
import { SupportedPlatform, getAdapter, TemplateFile } from "../../adapters/index.js";
import { ProcessLock } from "./lock.js";


import { resolveManagedPath, LEGACY_SHARED_CONFIG } from "./managed-path.js";

export type InstallScope = "global" | "local";

export interface InstallOptions {
  workspaceRoot?: string;
  homeDir?: string;
  scope?: InstallScope; // default: "global"
  platform?: SupportedPlatform; // default: "antigravity" or detected
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
  private dryRun: boolean;
  private force: boolean;
  private templateDir?: string;

  constructor(options: InstallOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.homeDir = path.resolve(options.homeDir || os.homedir());
    this.scope = options.scope || "global"; // Global first by default!
    this.platform = options.platform || "antigravity";
    this.dryRun = !!options.dryRun;
    this.force = !!options.force;
    this.templateDir = options.templateDir;
  }

  public getBaseDir(): string {
    return this.scope === "global" ? this.homeDir : this.workspaceRoot;
  }

  private getTargetPlatforms(): ("antigravity" | "claude-code" | "codex")[] {
    if (this.platform === "all") {
      return ["antigravity", "claude-code", "codex"];
    }
    return [this.platform as "antigravity" | "claude-code" | "codex"];
  }

  public plan(): { items: InstallPlanItem[]; conflicts: string[] } {
    const baseDir = this.getBaseDir();
    const existingManifest = ManifestManager.load(baseDir);
    const managedFilesMap = new Map<string, ManifestFileEntry>();

    if (existingManifest) {
      for (const entry of existingManifest.files) {
        managedFilesMap.set(entry.path, entry);
      }
    }

    const items: InstallPlanItem[] = [];
    const conflicts: string[] = [];
    const targetPlatforms = this.getTargetPlatforms();

    for (const p of targetPlatforms) {
      const adapter = getAdapter(p);
      const templateFiles: TemplateFile[] = adapter.getTemplateFiles({
        templateRootDir: this.templateDir,
        isGlobal: this.scope === "global",
        homeDir: this.homeDir
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

        if (!fs.existsSync(fullDestPath)) {
          items.push({
            relativePath: tpl.relativePath,
            platform: p,
            action: "create",
            reason: `New ${p} configuration file`,
            sourceContent: tpl.sourceContent,
            hash: newHash,
          });
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
                reason: previous ? "Managed file has user edits; use --force to replace it." : "Unmanaged file exists; use --force to replace it.",
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
      try {
        ({ items, conflicts } = this.plan());
        resolveManagedPath(baseDir, ".agent-code-review.json");
      } catch (error) {
        return { scope: this.scope, baseDir, platforms: this.getTargetPlatforms(), success: false,
          dryRun: this.dryRun, items: [], manifestSaved: false, errors: [(error as Error).message] };
      }
      const targetPlatforms = this.getTargetPlatforms();

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
            `Installation aborted due to ${conflicts.length} conflicting file(s): ${conflicts.join(", ")}; shared configuration conflicts require manual resolution.`
          ]
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
        errors: []
      };
    }

    // A. 无锁快路径（只读检查，几十毫秒）：
    // 若未指定 --force，先快速比对目标平台与当前文件哈希。
    // 若已覆盖目标平台、版本一致且所有文件均为 skip-identical 且无冲突：
    // 说明系统已处于最新安装状态，直接成功返回，完全不加锁、不写盘。
    if (!this.force) {
      try {
        const manifest = ManifestManager.load(baseDir);
        const targetPlatforms = this.getTargetPlatforms();
        const hasLegacyEntry = manifest && manifest.files.some((f) => f.path === LEGACY_SHARED_CONFIG);
        const allCovered = manifest && !hasLegacyEntry && targetPlatforms.every((p) => manifest.platforms.includes(p));
        if (allCovered) {
          const quickPlan = this.plan();
          if (
            quickPlan.conflicts.length === 0 &&
            quickPlan.items.length > 0 &&
            quickPlan.items.every((i) => i.action === "skip-identical")
          ) {
            return {
              scope: this.scope,
              baseDir,
              platforms: targetPlatforms,
              success: true,
              dryRun: false,
              items: quickPlan.items,
              manifestSaved: false,
              alreadyUpToDate: true,
              errors: []
            };
          }
        }
      } catch {
        // 快速检查遇异常时平滑进入加锁流程
      }
    }

    // B. 加锁流程：进入独占排他锁，执行物理文件安装。
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
        errors: [(error as Error).message]
      };
    }
  }

  private executeLocked(baseDir: string): InstallResult {
    return ProcessLock.withLock(baseDir, () => {
      let items: InstallPlanItem[];
      let conflicts: string[];
      try {
        // C. 临界区内双重校验：在锁内重新评估 plan，纳入锁竞争期间其他进程已完成的修改
        ({ items, conflicts } = this.plan());
        resolveManagedPath(baseDir, ".agent-code-review.json");
      } catch (error) {
        return { scope: this.scope, baseDir, platforms: this.getTargetPlatforms(), success: false,
          dryRun: false, items: [], manifestSaved: false, errors: [(error as Error).message] };
      }
      const targetPlatforms = this.getTargetPlatforms();

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
            `Installation aborted due to ${conflicts.length} conflicting file(s): ${conflicts.join(", ")}; shared configuration conflicts require manual resolution.`
          ]
        };
      }

      // C. 临界区内双重检查：若等待锁期间排在前面的进程已完成全部写入且无遗留条目，无需重复写盘
      const existingManifest = ManifestManager.load(baseDir);
      const hasLegacyEntry = existingManifest && existingManifest.files.some((f) => f.path === LEGACY_SHARED_CONFIG);
      const hasModifications = items.some((i) => i.action === "create" || i.action === "update");
      if (!hasModifications && !hasLegacyEntry && !this.force && items.length > 0) {
        return {
          scope: this.scope,
          baseDir,
          platforms: targetPlatforms,
          success: true,
          dryRun: false,
          items,
          manifestSaved: false,
          alreadyUpToDate: true,
          errors: []
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

            fs.writeFileSync(fullPath, item.sourceContent, "utf-8");
          }

          manifestFilesMap.set(item.relativePath, {
            path: item.relativePath,
            hash: item.hash,
            platform: item.platform,
            installedAt: now
          });
        }

        const combinedPlatforms = Array.from(
          new Set([...(existingManifest?.platforms || []), ...targetPlatforms])
        );

        const manifest: InstallationManifest = {
          schemaVersion: "1.0.0",
          packageVersion: "0.1.0",
          scope: this.scope,
          platforms: combinedPlatforms,
          installedAt: existingManifest?.installedAt || now,
          updatedAt: now,
          files: Array.from(manifestFilesMap.values())
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
          errors: []
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
        // 恢复被更新文件的原始内容
        for (const [updatedPath, originalContent] of previousFileContents.entries()) {
          try {
            fs.writeFileSync(updatedPath, originalContent, "utf-8");
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
            `Installation failed during file write: ${(err as Error).message}. All partially written files have been rolled back.`
          ]
        };
      }
    });
  }
}
