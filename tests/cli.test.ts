import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { runInit, runUpdate } from "../src/commands/init.js";
import { runScope } from "../src/commands/scope.js";
import { runUninstall } from "../src/commands/uninstall.js";
import { Installer } from "../src/lib/installer.js";
import { ProcessLock } from "../src/lib/lock.js";
import { ManifestManager } from "../src/lib/manifest.js";
import { Uninstaller } from "../src/lib/uninstaller.js";

describe("CLI Commands Integration", () => {
  let tempDir: string;
  let tempHome: string;
  let originalCwd: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      HOMEDRIVE: process.env.HOMEDRIVE,
      HOMEPATH: process.env.HOMEPATH,
    };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acr-cli-test-"));
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "acr-cli-home-"));

    // Secure all OS environment variables for homedir resolution (POSIX + Windows)
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("should run global init and doctor successfully by default via os.homedir()", () => {
    expect(os.homedir()).toBe(tempHome);

    const initCode = runInit({ platform: "antigravity" });
    expect(initCode).toBe(0);
    expect(fs.existsSync(path.join(tempHome, ".agent-code-review.json"))).toBe(true);

    const doctorCode = runDoctor();
    expect(doctorCode).toBe(0);

    const uninstallCode = runUninstall({ global: true });
    expect(uninstallCode).toBe(0);
    expect(fs.existsSync(path.join(tempHome, ".agent-code-review.json"))).toBe(false);
  });

  it("should run local init and uninstall when --local is provided", () => {
    const initCode = runInit({ local: true, platform: "antigravity" });
    expect(initCode).toBe(0);
    expect(fs.existsSync(path.join(tempDir, ".agent-code-review.json"))).toBe(true);

    const uninstallCode = runUninstall({ local: true });
    expect(uninstallCode).toBe(0);
    expect(fs.existsSync(path.join(tempDir, ".agent-code-review.json"))).toBe(false);
  });

  it("should run scope command in git repository", () => {
    fs.writeFileSync(path.join(tempDir, "sample.txt"), "hello world");
    const scopeCode = runScope("uncommitted", { json: true });
    expect(scopeCode).toBe(0);
  });

  it("should show already up to date notice when run a second time for same platform", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      const code1 = runInit({ platform: "antigravity" });
      expect(code1).toBe(0);

      const code2 = runInit({ platform: "antigravity" });
      expect(code2).toBe(0);
      expect(logs.some((l) => l.includes("已经安装且已是最新状态"))).toBe(true);
      expect(logs.some((l) => l.includes("无需重复安装"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  it("should preserve --local and --platform in force hint and avoid expanding platforms when re-run on multi-host machine", () => {
    // 模拟本机同时检测到多个宿主（Antigravity + Claude Code + Codex）
    fs.mkdirSync(path.join(tempHome, ".gemini/antigravity-cli"), { recursive: true });
    fs.writeFileSync(path.join(tempHome, ".gemini/antigravity-cli/settings.json"), "{}");
    fs.mkdirSync(path.join(tempHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tempHome, ".claude/settings.json"), "{}");
    fs.mkdirSync(path.join(tempHome, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tempHome, ".codex/config.toml"), "");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      expect(runInit({ local: true, platform: "codex" })).toBe(0);
      expect(runInit({ local: true, platform: "codex" })).toBe(0);

      const hintLine = logs.find((l) => l.includes("强制重新覆盖安装:"));
      expect(hintLine).toContain("npx agent-code-review init --local --platform codex --force");

      // 按提示参数重放强制覆盖安装，平台应严格保持为 ["codex"]，不得扩展为全部三个平台
      const platformMatch = hintLine?.match(/--platform\s+(\S+)/);
      expect(platformMatch?.[1]).toBe("codex");
      expect(
        runInit({
          local: hintLine?.includes("--local") ?? false,
          platform: platformMatch?.[1],
          force: hintLine?.includes("--force") ?? false,
        }),
      ).toBe(0);

      expect(ManifestManager.load(tempDir)?.platforms).toEqual(["codex"]);
      expect(fs.existsSync(path.join(tempDir, ".claude/agents/correctness-reviewer.md"))).toBe(
        false,
      );
      expect(
        fs.existsSync(path.join(tempDir, ".agents/agents/correctness-reviewer/agent.md")),
      ).toBe(false);
    } finally {
      console.log = origLog;
    }
  });

  it("should preserve explicit --platform in update force hint and respect platform restriction", () => {
    expect(runInit({ local: true, platform: "antigravity" })).toBe(0);
    expect(runInit({ local: true, platform: "codex" })).toBe(0);

    // 用户自定义了 Antigravity 的 agent 文件；当仅执行 update --platform codex 时不应覆盖它
    const agyAgent = path.join(tempDir, ".agents/agents/correctness-reviewer/agent.md");
    fs.appendFileSync(agyAgent, "\n# User customization\n");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      expect(runUpdate({ local: true, platform: "codex" })).toBe(0);
      const hintLine = logs.find((l) => l.includes("强制重新覆盖安装:"));
      expect(hintLine).toContain("npx agent-code-review update --local --platform codex --force");

      const platformMatch = hintLine?.match(/--platform\s+(\S+)/);
      expect(
        runUpdate({
          local: hintLine?.includes("--local") ?? false,
          platform: platformMatch?.[1],
          force: hintLine?.includes("--force") ?? false,
        }),
      ).toBe(0);

      expect(fs.readFileSync(agyAgent, "utf-8")).toContain("# User customization");
      expect(ManifestManager.load(tempDir)?.platforms).toEqual(["antigravity", "codex"]);
    } finally {
      console.log = origLog;
    }
  });

  it("should update only manifest-recorded platforms instead of re-detecting all host platforms", () => {
    // 模拟全局家目录存在多个已安装的宿主（Claude Code 与 Codex），但用户本地只安装了 codex
    fs.mkdirSync(path.join(tempHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tempHome, ".claude/settings.json"), "{}");
    fs.mkdirSync(path.join(tempHome, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tempHome, ".codex/config.toml"), "");

    expect(runInit({ local: true, platform: "codex" })).toBe(0);
    const localSkill = path.join(tempDir, ".agents/skills/code-review/SKILL.md");
    fs.writeFileSync(localSkill, "outdated content");

    // 无 --platform 调用 runUpdate({ local: true, force: true }) 时应仅更新 manifest 记录的 codex，
    // 不得因检测到 .claude 而顺便安装 claude-code
    expect(runUpdate({ local: true, force: true })).toBe(0);
    const manifest = ManifestManager.load(tempDir);
    expect(manifest?.platforms).toEqual(["codex"]);
    expect(fs.existsSync(path.join(tempDir, ".claude/agents/correctness-reviewer.md"))).toBe(false);
    expect(fs.readFileSync(localSkill, "utf-8")).toContain("# Independent code review");
  });

  it("should update an explicit subset of manifest platforms (antigravity + codex) without adding claude-code", () => {
    expect(runInit({ local: true, platform: "antigravity" })).toBe(0);
    expect(runInit({ local: true, platform: "codex" })).toBe(0);

    const agyAgent = path.join(tempDir, ".agents/agents/correctness-reviewer/agent.md");
    const codexAgent = path.join(tempDir, ".codex/agents/correctness-reviewer.toml");
    fs.writeFileSync(agyAgent, "stale agy");
    fs.writeFileSync(codexAgent, "stale codex");

    expect(runUpdate({ local: true, force: true })).toBe(0);
    const manifest = ManifestManager.load(tempDir);
    expect(manifest?.platforms).toEqual(["antigravity", "codex"]);
    expect(fs.readFileSync(agyAgent, "utf-8")).toContain("# Correctness Reviewer");
    expect(fs.readFileSync(codexAgent, "utf-8")).toContain("correctness_reviewer");
    expect(fs.existsSync(path.join(tempDir, ".claude/agents/correctness-reviewer.md"))).toBe(false);
  });

  it("should fail cleanly when runUpdate is invoked in a scope without an existing installation", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      expect(runUpdate({ local: true })).toBe(1);
      expect(errors.some((e) => e.includes("No local Agent Code Review installation found"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(tempDir, ".agent-code-review.json"))).toBe(false);
    } finally {
      console.error = origError;
    }
  });

  it("should reject an empty string --platform value instead of falling back to defaults", () => {
    expect(runInit({ local: true, platform: "codex" })).toBe(0);

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      expect(runInit({ local: true, platform: "" })).toBe(1);
      expect(runUpdate({ local: true, platform: "" })).toBe(1);
      expect(errors.filter((e) => e.includes("Unknown platform ''"))).toHaveLength(2);
    } finally {
      console.error = origError;
    }
  });

  it("should abort update without resurrecting files if uninstalled before acquiring lock", () => {
    expect(runInit({ local: true, platform: "codex" })).toBe(0);

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    const origWithLock = ProcessLock.withLock.bind(ProcessLock);
    const lockSpy = vi.spyOn(ProcessLock, "withLock").mockImplementationOnce((dir, fn) => {
      lockSpy.mockRestore();
      new Uninstaller({ workspaceRoot: dir, scope: "local" }).execute();
      return origWithLock(dir, fn);
    });

    try {
      expect(runUpdate({ local: true, force: true })).toBe(1);
      expect(errors.some((e) => e.includes("No local Agent Code Review installation found"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(tempDir, ".agent-code-review.json"))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, ".codex/agents/correctness-reviewer.toml"))).toBe(
        false,
      );
    } finally {
      vi.restoreAllMocks();
      console.error = origError;
    }
  });

  it("should refresh manifest target platforms under lock when another platform is added concurrently", () => {
    expect(runInit({ local: true, platform: "codex" })).toBe(0);

    const origWithLock = ProcessLock.withLock.bind(ProcessLock);
    const agyAgent = path.join(tempDir, ".agents/agents/correctness-reviewer/agent.md");
    const lockSpy = vi.spyOn(ProcessLock, "withLock").mockImplementationOnce((dir, fn) => {
      lockSpy.mockRestore();
      // 模拟并发进程在 runUpdate 等待锁期间新增了 antigravity 并留下需刷新内容
      new Installer({ workspaceRoot: dir, scope: "local", platform: "antigravity" }).execute();
      fs.writeFileSync(agyAgent, "stale antigravity");
      return origWithLock(dir, fn);
    });

    try {
      expect(runUpdate({ local: true, force: true })).toBe(0);
      const manifest = ManifestManager.load(tempDir);
      expect(manifest?.platforms).toEqual(["codex", "antigravity"]);
      expect(fs.readFileSync(agyAgent, "utf-8")).toContain("# Correctness Reviewer");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
