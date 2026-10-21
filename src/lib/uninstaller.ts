import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ManifestManager, InstallationManifest } from "./manifest.js";
import { InstallScope } from "./installer.js";

import { resolveManagedPath } from "./managed-path.js";

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

  private cleanEmptyParentDirs(filePath: string, baseDir: string): void {
    let currentDir = path.dirname(filePath);
    while (currentDir !== baseDir && currentDir !== path.dirname(currentDir)) {
      try {
        const files = fs.readdirSync(currentDir);
        if (files.length === 0) {
          fs.rmdirSync(currentDir);
          currentDir = path.dirname(currentDir);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }

  public execute(): UninstallResult {
    const baseDir = this.getBaseDir();
    const manifest = ManifestManager.load(baseDir);

    if (!manifest) {
      return {
        scope: this.scope,
        baseDir,
        success: false,
        dryRun: this.dryRun,
        removedFiles: [],
        skippedFiles: [],
        manifestRemoved: false,
        errors: [`No ${this.scope} .agent-code-review.json manifest found in ${baseDir}. Nothing to uninstall.`]
      };
    }

    const removedFiles: string[] = [];
    const skippedFiles: string[] = [];
    const errors: string[] = [];

    for (const entry of manifest.files) {
      try {
        if (entry.path === ".agent-code-review.json") throw new Error("The manifest is not a managed content file.");
        const fullPath = resolveManagedPath(baseDir, entry.path);
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, "utf-8");
        const modified = ManifestManager.computeHash(content) !== entry.hash;
        if (entry.path === ".codex/config.toml") {
          // Old manifests claimed ownership of an entire shared file. Never delete
          // or force-overwrite that file without explicit restoration metadata.
          if (entry.sharedConfig !== true || entry.originalContent === undefined || modified) {
            throw new Error("Shared configuration has edits or legacy ownership metadata; preserving user configuration.");
          }
          if (!this.dryRun) {
            resolveManagedPath(baseDir, entry.path);
            if (entry.originalContent === null) fs.unlinkSync(fullPath);
            else fs.writeFileSync(fullPath, entry.originalContent, "utf-8");
          }
        } else {
          if (entry.sharedConfig || entry.originalContent !== undefined) {
            throw new Error("Restoration metadata is only allowed for the shared Codex configuration.");
          }
          if (modified && !this.force) {
            throw new Error("File was modified after installation; preserving user edits (use --force to remove).");
          }
          if (!this.dryRun) {
            resolveManagedPath(baseDir, entry.path);
            fs.unlinkSync(fullPath);
          }
        }
        removedFiles.push(entry.path);
        if (!this.dryRun) this.cleanEmptyParentDirs(fullPath, baseDir);
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
      removedFiles, skippedFiles, manifestRemoved, errors
    };
  }
}
