import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PLATFORMS, type PlatformMetadata } from "../../adapters/index.js";
import { GitScopeResolver } from "../../core/git/scope.js";
import { type DetectedPlatform, detectPlatforms } from "./detect-platform.js";
import { ProcessLock } from "./lock.js";
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
  private static verifyScopeIntegrity(
    baseDir: string,
    manifest: InstallationManifest,
    scope: "global" | "local",
  ): { check: DoctorCheckResult; healthy: boolean } {
    const integrityName = scope === "global" ? "Global Files Integrity" : "Local Files Integrity";
    let missing = 0;
    let modified = 0;

    for (const entry of manifest.files) {
      let full: string;
      try {
        full = resolveManagedPath(baseDir, entry.path);
      } catch {
        missing++;
        continue;
      }
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isFile()) {
          // 被替换成了目录或特殊文件类型（V-10）
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
      return {
        healthy: false,
        check: {
          name: integrityName,
          status: "fail",
          message: `${missing} ${scope} managed file(s) are missing on disk.`,
        },
      };
    }
    if (modified > 0) {
      return {
        healthy: true,
        check: {
          name: integrityName,
          status: "warn",
          message: `${modified} ${scope} managed file(s) have local user customizations or non-file entries.`,
        },
      };
    }
    return {
      healthy: true,
      check: {
        name: integrityName,
        status: "pass",
        message: `All ${manifest.files.length} ${scope} files match installation hashes.`,
      },
    };
  }

  private static inspectScopeLocked(
    baseDir: string,
    scope: "global" | "local",
  ): {
    manifest: InstallationManifest | null;
    checks: DoctorCheckResult[];
    healthy: boolean;
  } {
    const installCheckName =
      scope === "global" ? "Global Installation" : "Local Project Installation";
    try {
      return ProcessLock.withInspectionLock(baseDir, () => {
        const manifest = ManifestManager.load(baseDir);
        if (!manifest) {
          if (scope === "global") {
            return {
              manifest: null,
              healthy: true,
              checks: [
                {
                  name: installCheckName,
                  status: "warn",
                  message:
                    "No global configuration found at ~/.agent-code-review.json. Run 'npx agent-code-review init' to install globally.",
                },
              ],
            };
          }
          return { manifest: null, healthy: true, checks: [] };
        }

        const platforms = Array.isArray(manifest.platforms)
          ? manifest.platforms.join(", ")
          : (manifest as { platform?: string }).platform || "antigravity";

        const installCheck: DoctorCheckResult = {
          name: installCheckName,
          status: "pass",
          message:
            scope === "global"
              ? `Global configuration active for [${platforms}] (version ${manifest.packageVersion}).`
              : `Project-level configuration present in workspace for [${platforms}].`,
        };

        const integrity = this.verifyScopeIntegrity(baseDir, manifest, scope);
        return {
          manifest,
          healthy: integrity.healthy,
          checks: [installCheck, integrity.check],
        };
      });
    } catch (error) {
      return {
        manifest: null,
        healthy: false,
        checks: [
          {
            name: installCheckName,
            status: "fail",
            message: (error as Error).message,
          },
        ],
      };
    }
  }

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
    const header =
      unverifiedEntries.length === 0
        ? "All supported platforms verified in native runtime environments:"
        : unverifiedEntries.length === platformEntries.length
          ? "All platforms are currently unverified in native runtime (review quality not validated):"
          : "Platform verification:";
    checks.push({
      name: "Platform Verification Status",
      status: unverifiedEntries.length > 0 ? "warn" : "pass",
      message: header + verificationDetails,
    });

    // Check 3 & 4: 串行持有各自目录的同一把 ProcessLock 完成安装清单与文件完整性核验，
    // 防止在并发安装回滚尚未结束时读到半提交状态（且不嵌套锁以避免 homeDir === workspaceRoot 死锁）
    const globalResult = this.inspectScopeLocked(homeDir, "global");
    const globalManifest = globalResult.manifest;
    checks.push(...globalResult.checks);
    if (!globalResult.healthy) {
      overallHealthy = false;
    }

    const gitResolver = new GitScopeResolver(workspaceRoot);
    const isGit = gitResolver.isGitRepo();
    const localResult = this.inspectScopeLocked(workspaceRoot, "local");
    const localManifest = localResult.manifest;
    checks.push(...localResult.checks);
    if (!localResult.healthy) {
      overallHealthy = false;
    }

    if (localManifest && globalManifest) {
      checks.push({
        name: "Configuration Precedence",
        status: "warn",
        message:
          "Local workspace configuration is present and will override global Agent Review settings for this project.",
      });
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
