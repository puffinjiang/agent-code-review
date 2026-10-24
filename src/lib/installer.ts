import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ManifestManager, InstallationManifest, ManifestFileEntry } from "./manifest.js";
import { SupportedPlatform, getAdapter, TemplateFile } from "../../adapters/index.js";
import { ProcessLock } from "./lock.js";


import { resolveManagedPath, LEGACY_SHARED_CONFIG } from "./managed-path.js";
import { getPackageVersion } from "./version.js";

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

    // 自动清理同目录下遗留的陈旧 .tmp. 文件（mtime > 1 小时，防止崩溃残留累积）
    try {
      const baseName = path.basename(fullPath);
      for (const file of fs.readdirSync(parentDir)) {
        if (file.startsWith(`${baseName}.tmp.`)) {
          const tmpFilePath = path.join(parentDir, file);
          try {
            const stat = fs.statSync(tmpFilePath);
            if (Date.now() - stat.mtimeMs > 3600_000) {
              fs.unlinkSync(tmpFilePath);
            }
          } catch {}
        }
      }
    } catch {}

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
      try { fs.unlinkSync(tmpPath); } catch {}
      throw writeErr;
    }
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
    // 若已覆盖目标平台、版本一致、无冲突、且清单中已完整登记全部待安装文件：
    // 说明系统已处于最新安装状态，直接成功返回，完全不加锁、不写盘。
    if (!this.force) {
      try {
        const manifest = ManifestManager.load(baseDir);
        const currentVersion = getPackageVersion();
        const targetPlatforms = this.getTargetPlatforms();
        const hasLegacyEntry = manifest && manifest.files.some((f) => f.path === LEGACY_SHARED_CONFIG);
        const isVersionCurrent = manifest?.packageVersion === currentVersion;
        const allCovered = manifest && !hasLegacyEntry && isVersionCurrent && targetPlatforms.every((p) => manifest.platforms.includes(p));

        if (allCovered) {
          const quickPlan = this.plan();
          // BUG-2 修复：manifest.files 必须完整登记 quickPlan 中的每一个文件且 hash 一致，防止孤儿文件漏入
          const manifestMap = new Map(manifest.files.map((f) => [f.path, f.hash]));
          const allFilesRegistered =
            quickPlan.items.length > 0 &&
            quickPlan.items.every((item) => manifestMap.get(item.relativePath) === item.hash);

          if (
            allFilesRegistered &&
            quickPlan.conflicts.length === 0 &&
            quickPlan.items.every((i) => i.action === "skip-identical")
          ) {
            // S-2 修复：已安装平台应取 manifest 的全集并集，而不是仅回显本次的目标参数
            const combinedPlatforms = Array.from(new Set([...manifest.platforms, ...targetPlatforms]));
            return {
              scope: this.scope,
              baseDir,
              platforms: combinedPlatforms,
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

      // C. 临界区内双重检查：若等待锁期间排在前面的进程已完成全部写入且 manifest 登记完整，无需重复写盘
      const existingManifest = ManifestManager.load(baseDir);
      const currentVersion = getPackageVersion();
      const hasLegacyEntry = existingManifest && existingManifest.files.some((f) => f.path === LEGACY_SHARED_CONFIG);
      const isVersionCurrent = existingManifest?.packageVersion === currentVersion;
      const allPlatformsCovered = existingManifest && targetPlatforms.every((p) => existingManifest.platforms.includes(p));
      const hasModifications = items.some((i) => i.action === "create" || i.action === "update");

      // BUG-2 修复：必须核对现有 manifest.files 是否真正登记了本次 plan 的全部文件且哈希一致
      const existingManifestMap = new Map(existingManifest?.files.map((f) => [f.path, f.hash]) || []);
      const allFilesRegistered =
        items.length > 0 &&
        items.every((item) => existingManifestMap.get(item.relativePath) === item.hash);

      if (
        !hasModifications &&
        !hasLegacyEntry &&
        !this.force &&
        allFilesRegistered &&
        allPlatformsCovered &&
        isVersionCurrent
      ) {
        // S-2 修复：已安装平台应取 manifest 的全集并集
        const combinedPlatforms = Array.from(new Set([...existingManifest.platforms, ...targetPlatforms]));
        return {
          scope: this.scope,
          baseDir,
          platforms: combinedPlatforms,
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

            Installer.writeAtomic(fullPath, item.sourceContent);
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
          packageVersion: getPackageVersion(),
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
            `Installation failed during file write: ${(err as Error).message}. All partially written files have been rolled back.`
          ]
        };
      }
    });
  }
}
