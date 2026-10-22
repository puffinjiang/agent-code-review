import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ManifestManager, InstallationManifest, ManifestFileEntry } from "./manifest.js";
import { SupportedPlatform, getAdapter, PLATFORMS } from "../../adapters/index.js";
import { TemplateFile } from "../../adapters/antigravity/index.js";

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

    if (this.dryRun) {
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

    const now = new Date().toISOString();
    const existingManifest = ManifestManager.load(baseDir);
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

    for (const item of items) {
      const fullPath = resolveManagedPath(baseDir, item.relativePath);
      const parentDir = path.dirname(fullPath);

      if (item.action === "create" || item.action === "update") {
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
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
  }
}
