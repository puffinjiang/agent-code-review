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

  it("should be idempotent when re-run globally", () => {
    const installer = new Installer({
      homeDir: tempHome,
      workspaceRoot: tempWorkspace,
      platform: "claude-code"
    });

    installer.execute();

    // Re-run
    const result2 = installer.execute();
    expect(result2.success).toBe(true);
    for (const item of result2.items) {
      expect(item.action).toBe("skip-identical");
    }
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
});
