import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
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
    expect(fs.existsSync(path.join(tempHome, ".codex/config.toml"))).toBe(true);
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

  it("should safely merge shared config files with backup", () => {
    // Pre-create existing .codex/config.toml
    const codexDir = path.join(tempHome, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, "config.toml");
    fs.writeFileSync(configPath, "# User existing config\nmodel = 'gpt-4'\n", "utf-8");

    const installer = new Installer({
      homeDir: tempHome,
      platform: "codex"
    });

    const result = installer.execute();
    expect(result.success).toBe(true);

    const mergedContent = fs.readFileSync(configPath, "utf-8");
    expect(mergedContent).toContain("model = 'gpt-4'");
    expect(mergedContent).toContain("[agents.correctness_reviewer]");

    // Verify backup created
    const files = fs.readdirSync(codexDir);
    const backup = files.find((f) => f.startsWith("config.toml.bak."));
    expect(backup).toBeDefined();
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
});
