import { execFile, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AntigravityAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  PLATFORMS,
} from "../adapters/index.js";
import { Doctor } from "../src/lib/doctor.js";
import { Installer } from "../src/lib/installer.js";
import { ProcessLock } from "../src/lib/lock.js";
import { ManifestManager } from "../src/lib/manifest.js";
import { Uninstaller } from "../src/lib/uninstaller.js";

describe("Global First Installer Lifecycle", () => {
  let tempHome: string;
  let tempWorkspace: string;

  beforeEach(() => {
    tempHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "acr-home-test-")));
    tempWorkspace = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "acr-workspace-test-")),
    );
    execSync("git init", { cwd: tempWorkspace, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
  });

  it("should default to GLOBAL installation in user home directory", () => {
    const installer = new Installer({
      homeDir: tempHome,
      workspaceRoot: tempWorkspace,
      platform: "antigravity",
    });

    expect(installer.getBaseDir()).toBe(tempHome);
    const result = installer.execute();

    expect(result.success).toBe(true);
    expect(result.scope).toBe("global");
    expect(result.baseDir).toBe(tempHome);

    // Global paths for Antigravity
    const globalSkill = path.join(tempHome, ".gemini/config/skills/code-review/SKILL.md");
    expect(fs.existsSync(globalSkill)).toBe(true);

    const globalAgent = path.join(tempHome, ".gemini/config/agents/correctness-reviewer/agent.md");
    expect(fs.existsSync(globalAgent)).toBe(true);

    // Workspace should NOT have been touched
    expect(fs.existsSync(path.join(tempWorkspace, ".agents"))).toBe(false);

    // Manifest should be at tempHome
    const manifest = ManifestManager.load(tempHome);
    expect(manifest).not.toBeNull();
    expect(manifest?.scope).toBe("global");
  });

  it("should support LOCAL installation when scope is local", () => {
    const installer = new Installer({
      homeDir: tempHome,
      workspaceRoot: tempWorkspace,
      scope: "local",
      platform: "antigravity",
    });

    const result = installer.execute();
    expect(result.success).toBe(true);
    expect(result.scope).toBe("local");

    // Local paths for Antigravity
    const localSkill = path.join(tempWorkspace, ".agents/skills/code-review/SKILL.md");
    expect(fs.existsSync(localSkill)).toBe(true);
  });

  it("should support MULTI-PLATFORM installation (--platform all)", () => {
    const installer = new Installer({
      homeDir: tempHome,
      workspaceRoot: tempWorkspace,
      scope: "global",
      platform: "all",
    });

    const result = installer.execute();
    expect(result.success).toBe(true);
    expect(result.platforms).toEqual(["antigravity", "claude-code", "codex"]);

    // Verify Antigravity
    expect(fs.existsSync(path.join(tempHome, ".gemini/config/skills/code-review/SKILL.md"))).toBe(
      true,
    );
    // Verify Claude Code
    expect(fs.existsSync(path.join(tempHome, ".claude/skills/code-review/SKILL.md"))).toBe(true);
    // Verify Codex
    expect(fs.existsSync(path.join(tempHome, ".agents/skills/code-review/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(tempHome, ".codex/agents/correctness-reviewer.toml"))).toBe(
      true,
    );
    // Codex 通过 .codex/agents/*.toml 自动发现角色，安装器不得创建 config.toml
    expect(fs.existsSync(path.join(tempHome, ".codex/config.toml"))).toBe(false);
  });

  it("should be idempotent when re-run globally without modifying files", () => {
    const installer = new Installer({
      homeDir: tempHome,
      workspaceRoot: tempWorkspace,
      platform: "claude-code",
    });

    const result1 = installer.execute();
    expect(result1.success).toBe(true);

    // Re-run without --force: evaluates alreadyUpToDate safely inside ProcessLock
    const result2 = installer.execute();
    expect(result2.success).toBe(true);
    expect(result2.alreadyUpToDate).toBe(true);
    expect(result2.manifestSaved).toBe(false);
    for (const item of result2.items) {
      expect(item.action).toBe("skip-identical");
    }
  });

  it("should not skip as alreadyUpToDate if manifest.files is missing planned files, and should heal manifest (BUG-2)", () => {
    // 1. Initial install for antigravity
    new Installer({ homeDir: tempHome, platform: "antigravity" }).execute();

    // 2. Install claude-code once to lay down the files on disk
    new Installer({ homeDir: tempHome, platform: "claude-code" }).execute();

    // 3. Simulate an incomplete/corrupted manifest where platforms contains claude-code
    // but files only contains antigravity files (e.g. legacy or partial state)
    const originalManifest = ManifestManager.load(tempHome)!;
    const antigravityOnlyFiles = originalManifest.files.filter((f) => f.platform === "antigravity");
    ManifestManager.save(tempHome, {
      ...originalManifest,
      platforms: ["antigravity", "claude-code"],
      files: antigravityOnlyFiles,
    });

    const tamperedManifest = ManifestManager.load(tempHome)!;
    expect(tamperedManifest.files.length).toBe(6);
    expect(tamperedManifest.platforms).toEqual(["antigravity", "claude-code"]);

    // 4. Run installer for claude-code. Even though files on disk are identical,
    // it MUST NOT treat as alreadyUpToDate because manifest.files does not cover all items!
    const reInstaller = new Installer({ homeDir: tempHome, platform: "claude-code" });
    const result = reInstaller.execute();

    expect(result.success).toBe(true);
    expect(result.alreadyUpToDate).toBeFalsy();

    // 5. Verify manifest is healed: all 12 files registered
    const healedManifest = ManifestManager.load(tempHome)!;
    expect(healedManifest.files.length).toBe(12);

    // 6. Verify uninstaller now cleans up all files without leaving orphans
    const uninstaller = new Uninstaller({ homeDir: tempHome });
    const unResult = uninstaller.execute();
    expect(unResult.success).toBe(true);
    expect(unResult.removedFiles.length).toBe(12);
    expect(fs.existsSync(path.join(tempHome, ".claude/skills/code-review/SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(tempHome, ".claude/agents/correctness-reviewer.md"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(tempHome, ".gemini/config/skills/code-review/SKILL.md"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(tempHome, ".agent-code-review.json"))).toBe(false);
  });

  it("should preserve user customized file mode (e.g. 0600) upon update (N-1)", () => {
    // 1. Initial installation
    new Installer({ homeDir: tempHome, platform: "claude-code" }).execute();
    const skillPath = path.join(tempHome, ".claude/skills/code-review/SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);

    // 2. User manually chmods (0o600 on POSIX; 0o666 on Windows NTFS)
    const targetMode = process.platform === "win32" ? 0o666 : 0o600;
    fs.chmodSync(skillPath, targetMode);
    const initialMode = fs.statSync(skillPath).mode & 0o777;
    expect(initialMode).toBe(targetMode);

    // 3. Force re-install / update
    new Installer({ homeDir: tempHome, platform: "claude-code", force: true }).execute();

    // 4. Mode must still be targetMode (not reset to default)
    const updatedMode = fs.statSync(skillPath).mode & 0o777;
    expect(updatedMode).toBe(targetMode);
  });

  it("should ignore leftover installer tmp files via git ignore (N-2)", () => {
    // 1. Local installation in git repository
    new Installer({
      homeDir: tempHome,
      workspaceRoot: tempWorkspace,
      scope: "local",
      platform: "antigravity",
    }).execute();

    // 2. Copy root .gitignore to tempWorkspace so git honors project rules
    const rootGitignore = fs.readFileSync(path.resolve(".gitignore"), "utf-8");
    fs.writeFileSync(path.join(tempWorkspace, ".gitignore"), rootGitignore);

    // 3. Simulate a crashed tmp file left behind in the workspace
    const leftoverTmp = path.join(
      tempWorkspace,
      ".agents/agents/correctness-reviewer.md.tmp.1234.abcd",
    );
    fs.writeFileSync(leftoverTmp, "partial garbage content");

    // 4. git status must ignore the .tmp. file
    const gitStatus = execSync("git status --porcelain", { cwd: tempWorkspace, encoding: "utf-8" });
    expect(gitStatus).not.toContain(".tmp.");
  });

  it("should purge stale .tmp files older than 1 hour on alreadyUpToDate and upon uninstall (Issue 1)", () => {
    // 1. Initial installation
    const initRes = new Installer({ homeDir: tempHome, platform: "claude-code" }).execute();
    expect(initRes.success).toBe(true);
    const skillPath = path.join(tempHome, ".claude/skills/code-review/SKILL.md");
    const parentDir = path.dirname(skillPath);

    // 2. Simulate a crashed stale .tmp file (mtime 2 hours ago)
    const staleTmp = path.join(parentDir, "SKILL.md.tmp.1111.aaaa");
    fs.writeFileSync(staleTmp, "stale content");
    const twoHoursAgo = (Date.now() - 7200_000) / 1000;
    fs.utimesSync(staleTmp, twoHoursAgo, twoHoursAgo);

    // Simulate a fresh .tmp file (mtime right now, should not be purged)
    const freshTmp = path.join(parentDir, "SKILL.md.tmp.2222.bbbb");
    fs.writeFileSync(freshTmp, "fresh content");

    // 3. Locked alreadyUpToDate installation should purge staleTmp without writing any files
    const upToDateRes = new Installer({ homeDir: tempHome, platform: "claude-code" }).execute();
    expect(upToDateRes.success).toBe(true);
    expect(upToDateRes.alreadyUpToDate).toBe(true);
    expect(fs.existsSync(staleTmp)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);

    // 4. Uninstall with force should clean up all remaining .tmp files for managed entries
    const unResult = new Uninstaller({ homeDir: tempHome, force: true }).execute();
    expect(unResult.success).toBe(true);
    expect(fs.existsSync(freshTmp)).toBe(false);
  });

  it("should never modify an existing .codex/config.toml", () => {
    // 用户的 Codex 配置可能包含模型、provider、MCP 等内容，任何写入都不可接受
    const codexDir = path.join(tempHome, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, "config.toml");
    const original =
      "# User existing config\nmodel = 'gpt-4'\n\n[mcp_servers.docs]\ncommand = 'docs-server'\n";
    fs.writeFileSync(configPath, original, "utf-8");

    const result = new Installer({ homeDir: tempHome, platform: "codex" }).execute();
    expect(result.success).toBe(true);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(original);
    // 不应产生备份残留
    expect(fs.readdirSync(codexDir).filter((f) => f.startsWith("config.toml.bak."))).toEqual([]);

    expect(new Uninstaller({ homeDir: tempHome }).execute().success).toBe(true);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("should protect modified files during uninstall unless forced", () => {
    const installer = new Installer({
      homeDir: tempHome,
      platform: "claude-code",
    });
    installer.execute();

    // Modify a file
    const skillPath = path.join(tempHome, ".claude/skills/code-review/SKILL.md");
    fs.appendFileSync(skillPath, "\n# User customized instruction\n");

    const uninstaller = new Uninstaller({
      homeDir: tempHome,
      scope: "global",
      force: false,
    });

    const unResult = uninstaller.execute();
    expect(unResult.skippedFiles).toContain(".claude/skills/code-review/SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);

    // Force uninstall
    const forceUninstaller = new Uninstaller({
      homeDir: tempHome,
      scope: "global",
      force: true,
    });
    const forceResult = forceUninstaller.execute();
    expect(forceResult.success).toBe(true);
    expect(fs.existsSync(skillPath)).toBe(false);
  });

  it("should detect when local config overrides global in doctor", () => {
    // Install global
    new Installer({ homeDir: tempHome, scope: "global", platform: "antigravity" }).execute();
    // Install local
    new Installer({
      homeDir: tempHome,
      workspaceRoot: tempWorkspace,
      scope: "local",
      platform: "antigravity",
    }).execute();

    const report = Doctor.diagnose({ homeDir: tempHome, workspaceRoot: tempWorkspace });
    const precedenceCheck = report.checks.find((c) => c.name === "Configuration Precedence");
    expect(precedenceCheck).toBeDefined();
    expect(precedenceCheck?.status).toBe("warn");
  });

  it("should report platform verification status in doctor", () => {
    const report = Doctor.diagnose({ homeDir: tempHome, workspaceRoot: tempWorkspace });
    const verificationCheck = report.checks.find((c) => c.name === "Platform Verification Status");
    expect(verificationCheck).toBeDefined();
    expect(verificationCheck?.status).toBe("pass");
    expect(verificationCheck?.message).toContain("verified");
    expect(verificationCheck?.message).toContain("Google Antigravity");
    expect(report.platformVerification).toBeDefined();
    expect(report.platformVerification.antigravity.verified).toBe(true);
    expect(report.platformVerification.codex.verified).toBe(true);
    expect(report.platformVerification["claude-code"].verified).toBe(true);
    expect(AntigravityAdapter.verified).toBe(PLATFORMS.antigravity.verified);
    expect(ClaudeCodeAdapter.verified).toBe(PLATFORMS["claude-code"].verified);
    expect(CodexAdapter.verified).toBe(PLATFORMS.codex.verified);
  });

  it("should safely merge manifest records when multiple platforms are installed concurrently across processes (D-13 / D-14)", async () => {
    const bundlePath = path.join(tempWorkspace, "installer-worker.mjs");
    buildSync({
      entryPoints: [path.resolve("src/index.ts")],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
    });

    const assetsRoot = path.resolve("assets");
    const runChildInstall = (platform: "claude-code" | "codex", holdLockMs: number) =>
      new Promise<{ success: boolean; platforms: string[] }>((resolve, reject) => {
        const script = `
          import { Installer, ProcessLock } from ${JSON.stringify(pathToFileURL(bundlePath).href)};
          const homeDir = ${JSON.stringify(tempHome)};
          const templateDir = ${JSON.stringify(assetsRoot)};
          const platform = ${JSON.stringify(platform)};
          const holdMs = ${holdLockMs};
          if (holdMs > 0) {
            const release = ProcessLock.acquire(homeDir);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
            release();
          }
          const res = new Installer({ homeDir, scope: "global", platform, templateDir }).execute();
          process.stdout.write(JSON.stringify({ success: res.success, platforms: res.platforms }));
        `;
        execFile(process.execPath, ["--input-type=module", "-e", script], (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve(JSON.parse(stdout));
        });
      });

    // Spawn two real child processes concurrently; one briefly holds the lock to force EEXIST contention
    const [resA, resB] = await Promise.all([
      runChildInstall("claude-code", 80),
      runChildInstall("codex", 0),
    ]);

    expect(resA.success).toBe(true);
    expect(resB.success).toBe(true);

    const manifest = ManifestManager.load(tempHome);
    expect(manifest).not.toBeNull();
    // Both platforms must be present in manifest.platforms
    expect(manifest?.platforms).toContain("claude-code");
    expect(manifest?.platforms).toContain("codex");

    // Both platforms' files must be present (6 claude-code + 6 codex = 12 files)
    const platformsInFiles = manifest!.files.map((f) => f.platform);
    expect(platformsInFiles).toContain("claude-code");
    expect(platformsInFiles).toContain("codex");
    expect(manifest!.files.length).toBe(12);

    // Verify files on disk
    expect(fs.existsSync(path.join(tempHome, ".claude/skills/code-review/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(tempHome, ".agents/skills/code-review/SKILL.md"))).toBe(true);
  });

  it("should not crash with EISDIR when doctor encounters a managed file replaced by a directory (V-10)", () => {
    // 1. Install global configuration
    const installer = new Installer({
      homeDir: tempHome,
      workspaceRoot: tempWorkspace,
      platform: "antigravity",
    });
    const installRes = installer.execute();
    expect(installRes.success).toBe(true);

    // 2. Replace one of the managed agent files with a directory
    const agentFilePath = path.join(tempHome, ".gemini/config/agents/security-reviewer/agent.md");
    expect(fs.existsSync(agentFilePath)).toBe(true);
    fs.unlinkSync(agentFilePath);
    fs.mkdirSync(agentFilePath); // directory at the same path!

    // 3. Run doctor: it MUST NOT crash with unhandled EISDIR error
    const diagnosis = Doctor.diagnose({
      workspaceRoot: tempWorkspace,
      homeDir: tempHome,
    });

    expect(diagnosis).toBeDefined();
    expect(diagnosis.globalManifest).not.toBeNull();
    const integrityCheck = diagnosis.checks.find((c) => c.name === "Global Files Integrity");
    expect(integrityCheck).toBeDefined();
    expect(integrityCheck?.status).toBe("warn");
    expect(integrityCheck?.message).toMatch(/local user customizations or non-file entries/);
  });

  it("should atomically roll back written files when installation fails mid-write (V-11)", () => {
    // Intercept Installer.writeAtomic: allow the first file to succeed, but fail on subsequent file
    // to simulate a real mid-write error (e.g. disk full, unexpected I/O failure) across all platforms
    const originalWriteAtomic = Installer.writeAtomic;
    let writeCount = 0;
    Installer.writeAtomic = (fullPath: string, content: string) => {
      writeCount++;
      if (writeCount > 1) {
        throw new Error("Simulated disk full or I/O failure mid-installation");
      }
      return originalWriteAtomic.call(Installer, fullPath, content);
    };

    try {
      const installer = new Installer({
        homeDir: tempHome,
        workspaceRoot: tempWorkspace,
        platform: "claude-code",
      });

      const result = installer.execute();
      expect(result.success).toBe(false);
      expect(result.manifestSaved).toBe(false);
      expect(result.errors[0]).toMatch(/All partially written files have been rolled back/);

      // Verify that NO partial agent files were left behind in ~/.claude/agents
      const agentsDir = path.join(tempHome, ".claude/agents");
      if (fs.existsSync(agentsDir)) {
        const files = fs.readdirSync(agentsDir);
        expect(files.length).toBe(0);
      }

      // No manifest file should exist
      expect(fs.existsSync(path.join(tempHome, ".agent-code-review.json"))).toBe(false);
    } finally {
      Installer.writeAtomic = originalWriteAtomic;
    }
  });

  it("should handle a managed path replaced by a directory cleanly without EISDIR crash in installer and uninstaller", () => {
    const targetDir = path.join(tempHome, ".claude/skills/code-review/SKILL.md");
    fs.mkdirSync(targetDir, { recursive: true });

    const dryRes = new Installer({
      homeDir: tempHome,
      platform: "claude-code",
      dryRun: true,
    }).execute();
    expect(dryRes.success).toBe(false);
    expect(dryRes.items.find((i) => i.action === "conflict")?.reason).toContain(
      "directory or non-regular file",
    );

    const forceRes = new Installer({
      homeDir: tempHome,
      platform: "claude-code",
      force: true,
    }).execute();
    expect(forceRes.success).toBe(false);
    expect(fs.statSync(targetDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(tempHome, ".claude/agents/correctness-reviewer.md"))).toBe(
      false,
    );

    // Also cover uninstaller when a managed file on an existing install becomes a directory
    const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), "acr-dir-uninstall-"));
    try {
      expect(new Installer({ homeDir: cleanHome, platform: "claude-code" }).execute().success).toBe(
        true,
      );
      const installedSkill = path.join(cleanHome, ".claude/skills/code-review/SKILL.md");
      fs.unlinkSync(installedSkill);
      fs.mkdirSync(installedSkill);

      const unRes = new Uninstaller({ homeDir: cleanHome, force: true }).execute();
      expect(unRes.success).toBe(false);
      expect(unRes.skippedFiles).toContain(".claude/skills/code-review/SKILL.md");
      expect(unRes.errors[0]).toContain("directory or non-regular file");
      expect(fs.statSync(installedSkill).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(cleanHome, { recursive: true, force: true });
    }
  });

  it("should require an existing manifest with valid platforms when updateExisting is enabled", () => {
    for (const opts of [
      { homeDir: tempHome, updateExisting: true },
      { homeDir: tempHome, updateExisting: true, force: true },
      { homeDir: tempHome, updateExisting: true, dryRun: true },
      { homeDir: tempHome, platform: "codex" as const, updateExisting: true },
    ]) {
      const res = new Installer(opts).execute();
      expect(res.success).toBe(false);
      expect(res.manifestSaved).toBe(false);
      expect(res.errors[0]).toContain("No global Agent Code Review installation found");
      expect(fs.existsSync(path.join(tempHome, ".agent-code-review.json"))).toBe(false);
    }

    // 存在但 platforms 不含受支持平台时，也应结构化失败
    ManifestManager.save(tempHome, {
      schemaVersion: "1.0.0",
      packageVersion: "0.3.3",
      scope: "global",
      platforms: ["unknown-host"],
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      files: [],
    });

    const invalidManifestRes = new Installer({
      homeDir: tempHome,
      updateExisting: true,
    }).execute();
    expect(invalidManifestRes.success).toBe(false);
    expect(invalidManifestRes.errors[0]).toContain("does not record any supported platforms");
  });

  it("should wait for ProcessLock instead of observing uncommitted writes prior to rollback in install, dryRun, and doctor", async () => {
    expect(new Installer({ homeDir: tempHome, platform: "codex" }).execute().success).toBe(true);

    const agentPath = path.join(tempHome, ".codex/agents/correctness-reviewer.toml");
    const officialContent = fs.readFileSync(agentPath, "utf-8");
    const userContent = `${officialContent}\n# user customization\n`;
    fs.writeFileSync(agentPath, userContent, "utf-8");

    const bundlePath = path.join(tempWorkspace, "reader-worker.mjs");
    buildSync({
      entryPoints: [path.resolve("src/index.ts")],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
    });

    const assetsRoot = path.resolve("assets");
    const runLockedChildInspection = async (scriptBody: string) => {
      const release = ProcessLock.acquire(tempHome);
      let childPromise: Promise<Record<string, unknown>>;
      try {
        // 模拟并发写者在锁内暂写新内容，随后失败并回滚到 userContent
        fs.writeFileSync(agentPath, officialContent, "utf-8");
        childPromise = new Promise((resolve, reject) => {
          execFile(
            process.execPath,
            ["--input-type=module", "-e", scriptBody],
            (err, stdout, stderr) => {
              if (err) return reject(new Error(stderr || err.message));
              resolve(JSON.parse(stdout) as Record<string, unknown>);
            },
          );
        });

        await new Promise((resolve) => setTimeout(resolve, 150));
        // 模拟写者失败回滚后再释放锁
        fs.writeFileSync(agentPath, userContent, "utf-8");
      } finally {
        release();
      }
      return childPromise;
    };

    const bundleHref = JSON.stringify(pathToFileURL(bundlePath).href);
    const homeLiteral = JSON.stringify(tempHome);
    const workspaceLiteral = JSON.stringify(tempWorkspace);
    const assetsLiteral = JSON.stringify(assetsRoot);

    // 1. 常规 install 等待锁（conc-002）
    const installRes = await runLockedChildInspection(`
      import { Installer } from ${bundleHref};
      const res = new Installer({
        homeDir: ${homeLiteral},
        scope: "global",
        platform: "codex",
        templateDir: ${assetsLiteral},
      }).execute();
      process.stdout.write(JSON.stringify({ success: res.success, alreadyUpToDate: res.alreadyUpToDate }));
    `);
    expect(installRes.success).toBe(false);
    expect(installRes.alreadyUpToDate).toBeFalsy();

    // 2. --dry-run 预览校验也必须等待同一把锁
    const dryRes = await runLockedChildInspection(`
      import { Installer } from ${bundleHref};
      const res = new Installer({
        homeDir: ${homeLiteral},
        scope: "global",
        platform: "codex",
        dryRun: true,
        templateDir: ${assetsLiteral},
      }).execute();
      process.stdout.write(JSON.stringify({ success: res.success, dryRun: res.dryRun }));
    `);
    expect(dryRes.success).toBe(false);
    expect(dryRes.dryRun).toBe(true);

    // 3. Doctor.diagnose 完整性校验也必须等待同一把锁
    const doctorRes = await runLockedChildInspection(`
      import { Doctor } from ${bundleHref};
      const report = Doctor.diagnose({
        homeDir: ${homeLiteral},
        workspaceRoot: ${workspaceLiteral},
      });
      const integrity = report.checks.find((c) => c.name === "Global Files Integrity");
      process.stdout.write(JSON.stringify({ integrityStatus: integrity?.status }));
    `);
    expect(doctorRes.integrityStatus).toBe("warn");
    expect(fs.readFileSync(agentPath, "utf-8")).toBe(userContent);

    // 4. homeDir === workspaceRoot 时 Doctor.diagnose 串行加锁不得自死锁
    const sameDirReport = Doctor.diagnose({ homeDir: tempHome, workspaceRoot: tempHome });
    expect(sameDirReport.overallHealthy).toBe(true);
  });
});
