import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";

import { resolveManagedPath } from "./managed-path.js";

export const MANIFEST_FILENAME = ".agent-code-review.json";

export interface ManifestFileEntry {
  path: string;
  hash: string;
  platform: string;
  installedAt: string;
  /**
   * @deprecated 仅用于读取旧版清单。早期版本向用户的 `~/.codex/config.toml`
   * 追加注册块，并在此保存原文快照。现已改为不写入该文件（Codex 支持
   * `~/.codex/agents/*.toml` 自动发现），不再产生这两个字段。
   */
  sharedConfig?: boolean;
  /** @deprecated 同 {@link ManifestFileEntry.sharedConfig} */
  originalContent?: string | null;
}

export interface InstallationManifest {
  schemaVersion: "1.0.0";
  packageVersion: string;
  scope: "global" | "local";
  platforms: string[];
  installedAt: string;
  updatedAt: string;
  files: ManifestFileEntry[];
}

export class ManifestManager {
  public static computeHash(content: string): string {
    return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  }

  public static getManifestPath(baseDir: string): string {
    return resolveManagedPath(baseDir, MANIFEST_FILENAME);
  }

  public static getGlobalManifestPath(homedir: string = os.homedir()): string {
    return path.join(homedir, MANIFEST_FILENAME);
  }

  public static getLocalManifestPath(workspaceRoot: string = process.cwd()): string {
    return path.join(workspaceRoot, MANIFEST_FILENAME);
  }

  public static load(baseDir: string): InstallationManifest | null {
    try {
      const manifestPath = this.getManifestPath(baseDir);
      if (!fs.existsSync(manifestPath)) return null;
      const raw = fs.readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as InstallationManifest & { platform?: string };
      // Older project installations used a single platform and omitted per-file metadata.
      if (manifest && Array.isArray(manifest.files) && typeof manifest.platform === "string") {
        manifest.scope ??= "local";
        manifest.platforms ??= [manifest.platform];
        for (const entry of manifest.files) {
          if (entry && typeof entry === "object") entry.platform ??= manifest.platform;
        }
      }
      if (!manifest || manifest.schemaVersion !== "1.0.0" ||
          !["global", "local"].includes(manifest.scope) ||
          !Array.isArray(manifest.platforms) || !manifest.platforms.every((p) => typeof p === "string") ||
          !Array.isArray(manifest.files) || !manifest.files.every((entry) =>
            entry && typeof entry.path === "string" && typeof entry.hash === "string" &&
            /^[a-f0-9]{64}$/.test(entry.hash) && typeof entry.platform === "string" &&
            (entry.sharedConfig === undefined || typeof entry.sharedConfig === "boolean") &&
            (entry.originalContent === undefined || entry.originalContent === null || typeof entry.originalContent === "string")
          )) return null;
      return manifest;
    } catch {
      return null;
    }
  }

  public static save(baseDir: string, manifest: InstallationManifest): void {
    const manifestPath = this.getManifestPath(baseDir);
    // Restoration metadata may include private user configuration.
    if (fs.existsSync(manifestPath)) fs.chmodSync(manifestPath, 0o600);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(manifestPath, 0o600);
  }

  public static remove(baseDir: string): boolean {
    const manifestPath = this.getManifestPath(baseDir);
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
      return true;
    }
    return false;
  }
}
