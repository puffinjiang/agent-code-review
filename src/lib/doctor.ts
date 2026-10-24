import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PLATFORMS, type PlatformMetadata } from "../../adapters/index.js";
import { GitScopeResolver } from "../../core/git/scope.js";
import { type DetectedPlatform, detectPlatforms } from "./detect-platform.js";
import { resolveManagedPath } from "./managed-path.js";
import { type InstallationManifest, ManifestManager } from "./manifest.js";

export interface DoctorCheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface DoctorReport {
  workspaceRoot: string;
  homeDir: string;
  overallHealthy: boolean;
  detectedPlatforms: DetectedPlatform[];
  platformVerification: Record<string, PlatformMetadata>;
  globalManifest: InstallationManifest | null;
  localManifest: InstallationManifest | null;
  checks: DoctorCheckResult[];
}

export class Doctor {
  public static diagnose(options: { workspaceRoot?: string; homeDir?: string } = {}): DoctorReport {
    const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    const homeDir = path.resolve(options.homeDir || os.homedir());
    const checks: DoctorCheckResult[] = [];
    let overallHealthy = true;

    // Check 1: Detected platforms on host
    const detected = detectPlatforms(homeDir);
    const installedNames = detected.filter((d) => d.detected).map((d) => d.name);
    if (installedNames.length > 0) {
      checks.push({
        name: "Detected Platforms",
        status: "pass",
        message: `Active platforms detected on machine: ${installedNames.join(", ")}.`,
      });
    } else {
      checks.push({
        name: "Detected Platforms",
        status: "warn",
        message: "No standard AI Coding Agent CLI binaries found in system PATH.",
      });
    }

    // Check 2: Platform verification status
    const platformEntries = Object.values(PLATFORMS);
    const unverifiedEntries = platformEntries.filter((p) => !p.verified);
    const verificationDetails = platformEntries
      .map(
        (p) =>
          `\n   - ${p.name}: ${p.verified ? "verified" : "unverified"}${p.notes ? ` (${p.notes})` : ""}`,
      )
      .join("");
    checks.push({
      name: "Platform Verification Status",
      status: unverifiedEntries.length > 0 ? "warn" : "pass",
      message:
        (unverifiedEntries.length === platformEntries.length
          ? "All platforms are currently unverified in native runtime (review quality not validated):"
          : "Platform verification:") + verificationDetails,
    });

    // Check 3: Global Installation Manifest
    const globalManifest = ManifestManager.load(homeDir);
    if (globalManifest) {
      const globalPlatforms = Array.isArray(globalManifest.platforms)
        ? globalManifest.platforms.join(", ")
        : (globalManifest as any).platform || "antigravity";

      checks.push({
        name: "Global Installation",
        status: "pass",
        message: `Global configuration active for [${globalPlatforms}] (version ${globalManifest.packageVersion}).`,
      });

      // Verify global files (V-10 修复：对目录、损坏符号链接及权限异常做安全防护，防止 EISDIR 崩溃)
      let missing = 0;
      let modified = 0;
      for (const entry of globalManifest.files) {
        let full: string;
        try {
          full = resolveManagedPath(homeDir, entry.path);
        } catch {
          missing++;
          continue;
        }
        try {
          const stat = fs.lstatSync(full);
          if (!stat.isFile()) {
            // 被替换成了目录或特殊文件类型
            modified++;
          } else {
            const currentHash = ManifestManager.computeHash(fs.readFileSync(full, "utf-8"));
            if (currentHash !== entry.hash) {
              modified++;
            }
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            missing++;
          } else {
            // EISDIR, EACCES 或其他读取异常，优雅归类为 modified/abnormal 而非直接抛出堆栈崩溃
            modified++;
          }
        }
      }

      if (missing > 0) {
        overallHealthy = false;
        checks.push({
          name: "Global Files Integrity",
          status: "fail",
          message: `${missing} global managed file(s) are missing on disk.`,
        });
      } else if (modified > 0) {
        checks.push({
          name: "Global Files Integrity",
          status: "warn",
          message: `${modified} global managed file(s) have local user customizations or non-file entries.`,
        });
      } else {
        checks.push({
          name: "Global Files Integrity",
          status: "pass",
          message: `All ${globalManifest.files.length} global files match installation hashes.`,
        });
      }
    } else {
      checks.push({
        name: "Global Installation",
        status: "warn",
        message:
          "No global configuration found at ~/.agent-code-review.json. Run 'npx agent-code-review init' to install globally.",
      });
    }

    // Check 4: Local Workspace Configuration
    const gitResolver = new GitScopeResolver(workspaceRoot);
    const isGit = gitResolver.isGitRepo();
    const localManifest = ManifestManager.load(workspaceRoot);

    if (localManifest) {
      const localPlatforms = Array.isArray(localManifest.platforms)
        ? localManifest.platforms.join(", ")
        : (localManifest as any).platform || "antigravity";

      checks.push({
        name: "Local Project Installation",
        status: "pass",
        message: `Project-level configuration present in workspace for [${localPlatforms}].`,
      });

      // Verify local files integrity (V-10 防护)
      let localMissing = 0;
      let localModified = 0;
      for (const entry of localManifest.files) {
        let full: string;
        try {
          full = resolveManagedPath(workspaceRoot, entry.path);
        } catch {
          localMissing++;
          continue;
        }
        try {
          const stat = fs.lstatSync(full);
          if (!stat.isFile()) {
            localModified++;
          } else {
            const currentHash = ManifestManager.computeHash(fs.readFileSync(full, "utf-8"));
            if (currentHash !== entry.hash) {
              localModified++;
            }
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            localMissing++;
          } else {
            localModified++;
          }
        }
      }

      if (localMissing > 0) {
        overallHealthy = false;
        checks.push({
          name: "Local Files Integrity",
          status: "fail",
          message: `${localMissing} local managed file(s) are missing on disk.`,
        });
      } else if (localModified > 0) {
        checks.push({
          name: "Local Files Integrity",
          status: "warn",
          message: `${localModified} local managed file(s) have local user customizations or non-file entries.`,
        });
      } else {
        checks.push({
          name: "Local Files Integrity",
          status: "pass",
          message: `All ${localManifest.files.length} local files match installation hashes.`,
        });
      }

      if (globalManifest) {
        checks.push({
          name: "Configuration Precedence",
          status: "warn",
          message:
            "Local workspace configuration is present and will override global Agent Review settings for this project.",
        });
      }
    }

    if (isGit) {
      checks.push({
        name: "Git Repository",
        status: "pass",
        message: "Valid Git repository detected in current workspace.",
      });
    }

    return {
      workspaceRoot,
      homeDir,
      overallHealthy,
      detectedPlatforms: detected,
      platformVerification: PLATFORMS,
      globalManifest,
      localManifest,
      checks,
    };
  }
}
