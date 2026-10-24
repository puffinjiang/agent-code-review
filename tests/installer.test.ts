import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, execFile } from "node:child_process";
import { buildSync } from "esbuild";
import { Installer } from "../src/lib/installer.js";
import { Uninstaller } from "../src/lib/uninstaller.js";
import { Doctor } from "../src/lib/doctor.js";
import { ManifestManager } from "../src/lib/manifest.js";

describe("Global First Installer Lifecycle", () => {
  let tempHome: string;
  let tempWorkspace: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "acr-home-test-"));
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "acr-workspace-test-"));
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
      platform: "antigravity"
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
      platform: "antigravity"
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
      platform: "all"
    });

    const result = installer.execute();
    expect(result.success).toBe(true);
    expect(result.platforms).toEqual(["antigravity", "claude-code", "codex"]);

    // Verify Antigravity
    expect(fs.existsSync(path.join(tempHome, ".gemini/config/skills/code-review/SKILL.md"))).toBe(true);
    // Verify Claude Code
    expect(fs.existsSync(path.join(tempHome, ".claude/skills/code-review/SKILL.md"))).toBe(true);
    // Verify Codex
    expect(fs.existsSync(path.join(tempHome, ".agents/skills/code-review/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(tempHome, ".codex/agents/correctness-reviewer.toml"))).toBe(true);
    // Codex 通过 .codex/agents/*.toml 自动发现角色，安装器不得创建 config.toml
    expect(fs.existsSync(path.join(tempHome, ".codex/config.toml"))).toBe(false);
  });

  it("should be idempotent when re-run globally and bypass lock on fast path", () => {
    const installer = new Installer({
      homeDir: tempHome,
      workspaceRoot: tempWorkspace,
      platform: "claude-code"
    });

    const result1 = installer.execute();
    expect(result1.success).toBe(true);

    // Re-run without --force: triggers Fast Path (A) without acquiring lock
    const result2 = installer.execute();
    expect(result2.success).toBe(true);
    expect(result2.alreadyUpToDate).toBe(true);
    for (const item of result2.items) {
      expect(item.action).toBe("skip-identical");
    }
  });

  it("should not skip via fast-path if manifest.files is missing planned files, and should heal manifest (BUG-2)", () => {
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
      files: antigravityOnlyFiles
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
    expect(fs.existsSync(path.join(tempHome, ".claude/agents/correctness-reviewer.md"))).toBe(false);
    expect(fs.existsSync(path.join(tempHome, ".gemini/config/skills/code-review/SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(tempHome, ".agent-code-review.json"))).toBe(false);
  });

  it("should preserve user customized file mode (e.g. 0600) upon update (N-1)", () => {
    // 1. Initial installation
    new Installer({ homeDir: tempHome, platform: "claude-code" }).execute();
    const skillPath = path.join(tempHome, ".claude/skills/code-review/SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);

    // 2. User manually chmods to 0o600
    fs.chmodSync(skillPath, 0o600);
    const initialMode = fs.statSync(skillPath).mode & 0o777;
    expect(initialMode).toBe(0o600);

    // 3. Force re-install / update
    new Installer({ homeDir: tempHome, platform: "claude-code", force: true }).execute();

    // 4. Mode must still be 0o600 (not reset to umask 0o644)
    const updatedMode = fs.statSync(skillPath).mode & 0o777;
    expect(updatedMode).toBe(0o600);
  });

  it("should ignore leftover installer tmp files via git ignore (N-2)", () => {
    // 1. Local installation in git repository
    new Installer({ homeDir: tempHome, workspaceRoot: tempWorkspace, scope: "local", platform: "antigravity" }).execute();

    // 2. Copy root .gitignore to tempWorkspace so git honors project rules
    const rootGitignore = fs.readFileSync(path.resolve(".gitignore"), "utf-8");
    fs.writeFileSync(path.join(tempWorkspace, ".gitignore"), rootGitignore);

    // 3. Simulate a crashed tmp file left behind in the workspace
    const leftoverTmp = path.join(tempWorkspace, ".agents/agents/correctness-reviewer.md.tmp.1234.abcd");
    fs.writeFileSync(leftoverTmp, "partial garbage content");

    // 4. git status must ignore the .tmp. file
    const gitStatus = execSync("git status --porcelain", { cwd: tempWorkspace, encoding: "utf-8" });
    expect(gitStatus).not.toContain(".tmp.");
  });

  it("should purge stale .tmp files older than 1 hour during writeAtomic and upon uninstall (Issue 1)", () => {
    // 1. Initial installation
    new Installer({ homeDir: tempHome, platform: "claude-code" }).execute();
    const skillPath = path.join(tempHome, ".claude/skills/code-review/SKILL.md");
    const parentDir = path.dirname(skillPath);

    // 2. Simulate a crashed stale .tmp file (mtime 2 hours ago)
    const staleTmp = path.join(parentDir, "SKILL.md.tmp.1111.aaaa");
    fs.writeFileSync(staleTmp, "stale content");
    const twoHoursAgo = (Date.now() - 7200_000) / 1000;
    fs.utimesSync(staleTmp, twoHoursAgo, twoHoursAgo);

    // Simulate a fresh .tmp file (mtime right now, should not be deleted by writeAtomic)
    const freshTmp = path.join(parentDir, "SKILL.md.tmp.2222.bbbb");
    fs.writeFileSync(freshTmp, "fresh content");

    // 3. Next writeAtomic call should purge staleTmp but keep freshTmp
    Installer.writeAtomic(skillPath, "# Updated Skill");
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
    const original = "# User existing config\nmodel = 'gpt-4'\n\n[mcp_servers.docs]\ncommand = 'docs-server'\n";
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
      platform: "claude-code"
    });
    installer.execute();

    // Modify a file
    const skillPath = path.join(tempHome, ".claude/skills/code-review/SKILL.md");
    fs.appendFileSync(skillPath, "\n# User customized instruction\n");

    const uninstaller = new Uninstaller({
      homeDir: tempHome,
      scope: "global",
      force: false
    });

    const unResult = uninstaller.execute();
    expect(unResult.skippedFiles).toContain(".claude/skills/code-review/SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);

    // Force uninstall
    const forceUninstaller = new Uninstaller({
      homeDir: tempHome,
      scope: "global",
      force: true
    });
    const forceResult = forceUninstaller.execute();
    expect(forceResult.success).toBe(true);
    expect(fs.existsSync(skillPath)).toBe(false);
  });

  it("should detect when local config overrides global in doctor", () => {
    // Install global
    new Installer({ homeDir: tempHome, scope: "global", platform: "antigravity" }).execute();
    // Install local
    new Installer({ homeDir: tempHome, workspaceRoot: tempWorkspace, scope: "local", platform: "antigravity" }).execute();

    const report = Doctor.diagnose({ homeDir: tempHome, workspaceRoot: tempWorkspace });
    const precedenceCheck = report.checks.find((c) => c.name === "Configuration Precedence");
    expect(precedenceCheck).toBeDefined();
    expect(precedenceCheck?.status).toBe("warn");
  });

  it("should report platform verification status in doctor", () => {
    const report = Doctor.diagnose({ homeDir: tempHome, workspaceRoot: tempWorkspace });
    const verificationCheck = report.checks.find((c) => c.name === "Platform Verification Status");
    expect(verificationCheck).toBeDefined();
    expect(verificationCheck?.status).toBe("warn");
    expect(verificationCheck?.message).toContain("unverified");
    expect(verificationCheck?.message).toContain("Codex CLI 0.163.0");
    expect(report.platformVerification).toBeDefined();
    expect(report.platformVerification.antigravity.verified).toBe(false);
  });

  it("should safely merge manifest records when multiple platforms are installed concurrently across processes (D-13 / D-14)", async () => {
    const bundlePath = path.join(tempWorkspace, "installer-worker.mjs");
    buildSync({
      entryPoints: [path.resolve("src/index.ts")],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm"
    });

    const assetsRoot = path.resolve("assets");
    const runChildInstall = (platform: "claude-code" | "codex", holdLockMs: number) =>
      new Promise<{ success: boolean; platforms: string[] }>((resolve, reject) => {
        const script = `
          import { Installer, ProcessLock } from ${JSON.stringify(bundlePath)};
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
      runChildInstall("codex", 0)
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
      platform: "antigravity"
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
      homeDir: tempHome
    });

    expect(diagnosis).toBeDefined();
    expect(diagnosis.globalManifest).not.toBeNull();
    const integrityCheck = diagnosis.checks.find((c) => c.name === "Global Files Integrity");
    expect(integrityCheck).toBeDefined();
    expect(integrityCheck?.status).toBe("warn");
    expect(integrityCheck?.message).toMatch(/local user customizations or non-file entries/);
  });

  it("should atomically roll back written files when installation fails mid-write (V-11)", () => {
    // Set up a directory with mode 0o555 (traversable for lstat during plan(), but unwritable)
    const skillsDir = path.join(tempHome, ".claude/skills/code-review");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.chmodSync(skillsDir, 0o555);

    try {
      const installer = new Installer({
        homeDir: tempHome,
        workspaceRoot: tempWorkspace,
        platform: "claude-code"
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
      // Restore permissions for cleanup
      try { fs.chmodSync(skillsDir, 0o777); } catch { /* ignore */ }
    }
  });
});
