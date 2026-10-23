import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ManifestManager } from "./manifest.js";
import { InstallScope } from "./installer.js";
import { ProcessLock } from "./lock.js";

import { resolveManagedPath, isCleanableDir, LEGACY_SHARED_CONFIG } from "./managed-path.js";

export interface UninstallOptions {
  workspaceRoot?: string;
  homeDir?: string;
  scope?: InstallScope; // default: "global"
  dryRun?: boolean;
  force?: boolean;
}

export interface UninstallResult {
  scope: InstallScope;
  baseDir: string;
  success: boolean;
  dryRun: boolean;
  removedFiles: string[];
  skippedFiles: string[];
  /**
   * 旧版本写入过、但本项目不再管理的用户配置文件。卸载器不触碰这些文件，
   * 需由用户按指引手动清理。
   */
  manualCleanup: string[];
  manifestRemoved: boolean;
  errors: string[];
}

export class Uninstaller {
  private workspaceRoot: string;
  private homeDir: string;
  private scope: InstallScope;
  private dryRun: boolean;
  private force: boolean;

  constructor(options: UninstallOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.homeDir = path.resolve(options.homeDir || os.homedir());
    this.scope = options.scope || "global"; // Global first by default
    this.dryRun = !!options.dryRun;
    this.force = !!options.force;
  }

  public getBaseDir(): string {
    return this.scope === "global" ? this.homeDir : this.workspaceRoot;
  }

  /**
   * 自下而上清理本项目独占且已变空的目录。
   *
   * 只清理 managed-path.ts 登记为「工具私有」的目录。宿主共享目录
   * （.claude / .codex / .gemini 及其子目录）一律保留 —— 判据是目录归属，
   * 而非 scope：local scope 下 <workspace>/.claude、<workspace>/.codex
   * 同属宿主项目级配置，同样受保护。
   */
  private cleanEmptyParentDirs(filePath: string, baseDir: string): void {
    let currentDir = path.dirname(filePath);
    while (currentDir !== baseDir) {
      const relDir = path.relative(baseDir, currentDir);
      if (!relDir || !isCleanableDir(relDir)) break;
      try {
        if (fs.readdirSync(currentDir).length !== 0) break;
        fs.rmdirSync(currentDir);
      } catch {
        break;
      }
      const parent = path.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }
  }

  public execute(): UninstallResult {
    const baseDir = this.getBaseDir();

    if (this.dryRun) {
      return this.executeInternal(baseDir);
    }

    try {
      return ProcessLock.withLock(baseDir, () => {
        return this.executeInternal(baseDir);
      });
    } catch (error) {
      // 加锁或文件系统异常统一转为结构化失败结果（D-14）
      return {
        scope: this.scope,
        baseDir,
        success: false,
        dryRun: false,
        removedFiles: [],
        skippedFiles: [],
        manualCleanup: [],
        manifestRemoved: false,
        errors: [(error as Error).message]
      };
    }
  }

  private executeInternal(baseDir: string): UninstallResult {
    const manifest = ManifestManager.load(baseDir);

    if (!manifest) {
      return {
        scope: this.scope,
        baseDir,
        success: false,
        dryRun: this.dryRun,
        removedFiles: [],
        skippedFiles: [],
        manualCleanup: [],
        manifestRemoved: false,
        errors: [`No ${this.scope} .agent-code-review.json manifest found in ${baseDir}. Nothing to uninstall.`]
      };
    }

    const removedFiles: string[] = [];
    const skippedFiles: string[] = [];
    const manualCleanup: string[] = [];
    const errors: string[] = [];

    for (const entry of manifest.files) {
      try {
        if (entry.path === ".agent-code-review.json") throw new Error("The manifest is not a managed content file.");
        const fullPath = resolveManagedPath(baseDir, entry.path);
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, "utf-8");
        const modified = ManifestManager.computeHash(content) !== entry.hash;
        if (entry.path === LEGACY_SHARED_CONFIG) {
          // 旧版本曾把用户的 .codex/config.toml 当作受管文件整份覆写。
          // 卸载器永不写入或删除用户配置：这段注册块在 Codex 改用
          // agents 目录自动发现后已无作用，交由用户按指引手动移除。
          manualCleanup.push(entry.path);
        } else {
          if (modified && !this.force) {
            throw new Error("File was modified after installation; preserving user edits (use --force to remove).");
          }
          if (!this.dryRun) {
            resolveManagedPath(baseDir, entry.path);
            fs.unlinkSync(fullPath);
          }
          removedFiles.push(entry.path);
          if (!this.dryRun) this.cleanEmptyParentDirs(fullPath, baseDir);
        }
      } catch (error) {
        skippedFiles.push(entry.path);
        errors.push(`Cannot remove '${entry.path}': ${(error as Error).message}`);
      }
    }

    let manifestRemoved = false;
    if (errors.length === 0) {
      manifestRemoved = this.dryRun ? true : ManifestManager.remove(baseDir);
    }
    return {
      scope: this.scope, baseDir, success: errors.length === 0, dryRun: this.dryRun,
      removedFiles, skippedFiles, manualCleanup, manifestRemoved, errors
    };
  }
}
