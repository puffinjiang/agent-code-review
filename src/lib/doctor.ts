import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ManifestManager, InstallationManifest } from "./manifest.js";
import { GitScopeResolver } from "../../core/git/scope.js";
import { detectPlatforms, DetectedPlatform } from "./detect-platform.js";

import { resolveManagedPath } from "./managed-path.js";

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
  globalManifest: InstallationManifest | null;
  localManifest: InstallationManifest | null;
  checks: DoctorCheckResult[];
}

export class Doctor {
  public static diagnose(options: {
    workspaceRoot?: string;
    homeDir?: string;
  } = {}): DoctorReport {
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
        message: `Active platforms detected on machine: ${installedNames.join(", ")}.`
      });
    } else {
      checks.push({
        name: "Detected Platforms",
        status: "warn",
        message: "No standard AI Coding Agent CLI binaries found in system PATH."
      });
    }

    // Check 2: Global Installation Manifest
    const globalManifest = ManifestManager.load(homeDir);
    if (globalManifest) {
      const globalPlatforms = Array.isArray(globalManifest.platforms)
        ? globalManifest.platforms.join(", ")
        : (globalManifest as any).platform || "antigravity";

      checks.push({
        name: "Global Installation",
        status: "pass",
        message: `Global configuration active for [${globalPlatforms}] (version ${globalManifest.packageVersion}).`
      });

      // Verify global files
      let missing = 0;
      let modified = 0;
      for (const entry of globalManifest.files) {
        let full: string;
        try { full = resolveManagedPath(homeDir, entry.path); }
        catch { missing++; continue; }
        if (!fs.existsSync(full)) {
          missing++;
        } else {
          const currentHash = ManifestManager.computeHash(fs.readFileSync(full, "utf-8"));
          if (currentHash !== entry.hash) {
            modified++;
          }
        }
      }

      if (missing > 0) {
        overallHealthy = false;
        checks.push({
          name: "Global Files Integrity",
          status: "fail",
          message: `${missing} global managed file(s) are missing on disk.`
        });
      } else if (modified > 0) {
        checks.push({
          name: "Global Files Integrity",
          status: "warn",
          message: `${modified} global managed file(s) have local user customizations.`
        });
      } else {
        checks.push({
          name: "Global Files Integrity",
          status: "pass",
          message: `All ${globalManifest.files.length} global files match installation hashes.`
        });
      }
    } else {
      checks.push({
        name: "Global Installation",
        status: "warn",
        message: "No global configuration found at ~/.agent-code-review.json. Run 'npx agent-code-review init' to install globally."
      });
    }

    // Check 3: Local Workspace Configuration
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
        message: `Project-level configuration present in workspace for [${localPlatforms}].`
      });

      if (globalManifest) {
        checks.push({
          name: "Configuration Precedence",
          status: "warn",
          message: "Local workspace configuration is present and will override global Agent Review settings for this project."
        });
      }
    }

    if (isGit) {
      checks.push({
        name: "Git Repository",
        status: "pass",
        message: "Valid Git repository detected in current workspace."
      });
    }

    return {
      workspaceRoot,
      homeDir,
      overallHealthy,
      detectedPlatforms: detected,
      globalManifest,
      localManifest,
      checks
    };
  }
}
