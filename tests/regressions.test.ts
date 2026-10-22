import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Installer } from "../src/lib/installer.js";
import { Uninstaller } from "../src/lib/uninstaller.js";
import { ManifestManager } from "../src/lib/manifest.js";
import { GitScopeResolver } from "../core/git/scope.js";
import { IndependentVerifier } from "../core/verifier/verifier.js";
import { getAdapter } from "../adapters/index.js";
import { resolveManagedPath } from "../src/lib/managed-path.js";
import { FindingsAggregator } from "../core/aggregator/aggregator.js";
import { ReviewReporter } from "../core/reporter/reporter.js";
import { Finding, validateFinding } from "../core/schemas/findings.js";

const finding: Finding = {
  id: "A", title: "Candidate", severity: "P2", status: "NEEDS_VERIFICATION",
  category: "correctness", file: "missing.ts", start_line: 10, end_line: 11,
  trigger: "An unverified claim", impact: "An unverified consequence", evidence: ["Reviewer claim"],
  recommendation: "Verify it", origin: "pre-existing-unrelated",
  verification: { method: "static-analysis", tests_executed: false }, root_cause_key: "operation:claim"
};

/**
 * Windows 创建符号链接需要开发者模式或管理员权限，缺失时相关用例会以 EPERM 失败。
 * 这属于运行环境限制而非产品缺陷，故按能力探测跳过。
 */
function symlinksAvailable(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "acr-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(probe, "target"), "x");
    fs.symlinkSync(path.join(probe, "target"), path.join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}
const canSymlink = symlinksAvailable();

describe("Review safety regressions", () => {
  let root: string;
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "acr-regression-"));
    repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(repo, "base"), "base\n");
    git("add", "."); git("commit", "-m", "base");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("does not execute shell metacharacters or Git options in a target", () => {
    const resolver = new GitScopeResolver(repo);
    expect(() => resolver.resolve({ target: "HEAD;>injected;#" })).toThrow();
    expect(() => resolver.resolve({ target: "--output=injected" })).toThrow();
    expect(fs.existsSync(path.join(repo, "injected"))).toBe(false);
  });

  // Win32 无法表示含换行或尾随空格的文件名（会被静默规范化，导致读回时 ENOENT）。
  it.skipIf(process.platform === "win32")("preserves special filenames in untracked and staged scopes", () => {
    const name = " 中文 file\n.ts ";
    fs.writeFileSync(path.join(repo, name), "export const marker = true;\n");
    const resolver = new GitScopeResolver(repo);
    const untracked = resolver.resolve();
    expect(untracked.untrackedFiles).toContain(name);
    expect(untracked.patch).toContain("+export const marker = true;");
    git("add", "--", name);
    expect(resolver.resolve({ target: "staged" }).changedFiles).toEqual([name]);
  });

  it("reviews unstaged edits to indexed files before the first commit", () => {
    const unborn = path.join(root, "unborn"); fs.mkdirSync(unborn);
    execFileSync("git", ["init"], { cwd: unborn, stdio: "ignore" });
    fs.writeFileSync(path.join(unborn, "new.ts"), "staged version\n");
    execFileSync("git", ["add", "new.ts"], { cwd: unborn });
    fs.writeFileSync(path.join(unborn, "new.ts"), "current version\n");
    fs.writeFileSync(path.join(unborn, "empty.ts"), "");
    const scope = new GitScopeResolver(unborn).resolve();
    expect(scope.changedFiles).toContain("new.ts");
    expect(scope.patch).toContain("+current version");
    expect(scope.patch).not.toContain("+staged version");
    expect(scope.patch).not.toContain("+1,0 @@");
    expect(new GitScopeResolver(unborn).resolve({ target: "staged" }).patch).toContain("+staged version");
  });

  it.skipIf(!canSymlink)("reviews a symlink target string rather than its external contents", () => {
    fs.writeFileSync(path.join(root, "secret"), "OUTSIDE_SECRET_MARKER");
    fs.symlinkSync("../secret", path.join(repo, "link"));
    const scope = new GitScopeResolver(repo).resolve();
    expect(scope.patch).toContain("120000");
    expect(scope.patch).toContain("+../secret");
    expect(scope.patch).not.toContain("OUTSIDE_SECRET_MARKER");
  });

  it("uses only the first-parent changes for a merge", () => {
    git("checkout", "-b", "feature");
    fs.writeFileSync(path.join(repo, "feature.txt"), "feature");
    git("add", "."); git("commit", "-m", "feature");
    git("checkout", "-");
    fs.writeFileSync(path.join(repo, "main.txt"), "main");
    git("add", "."); git("commit", "-m", "main");
    git("merge", "--no-ff", "feature", "-m", "merge");
    const scope = new GitScopeResolver(repo).resolve({ target: "HEAD" });
    expect(scope.isMergeCommit).toBe(true);
    expect(scope.changedFiles).toEqual(["feature.txt"]);
    expect(scope.patch).not.toContain("+main");
  });

  it("requires explicit verification facts and preserves origin", () => {
    const [result] = IndependentVerifier.verifyBatch([finding]);
    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.origin).toBe("pre-existing-unrelated");
    expect(result.verification.notes).not.toContain("Independently verified");
    expect(IndependentVerifier.evaluateCandidate({ finding, concreteTriggerPossible: true }).status).toBe("NEEDS_VERIFICATION");
    expect(IndependentVerifier.evaluateCandidate({ finding, hasExistingProtection: true }).origin).toBe(finding.origin);
  });

  it("keeps distinct nearby causes, triggers, statuses, and file locations", () => {
    const variants: Finding[] = [finding,
      { ...finding, id: "B", root_cause_key: "another:cause", start_line: 12, end_line: 13 },
      { ...finding, id: "C", file: "another.ts", start_line: 500, end_line: 501 },
      { ...finding, id: "D", trigger: "Different reachable trigger" },
      { ...finding, id: "E", status: "REJECTED" }
    ];
    expect(FindingsAggregator.aggregate(variants)).toHaveLength(5);
  });

  it("protects edited managed files during update and allows explicit force", () => {
    const options = { homeDir: root, platform: "claude-code" as const };
    expect(new Installer(options).execute().success).toBe(true);
    const file = path.join(root, ".claude/skills/code-review/SKILL.md");
    fs.appendFileSync(file, "\nUSER_CUSTOMIZATION\n");
    const content = fs.readFileSync(file, "utf-8");
    expect(new Installer(options).execute().success).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe(content);
    expect(new Installer({ ...options, force: true }).execute().success).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).not.toContain("USER_CUSTOMIZATION");
  });

  it.each(["", "# existing\nmodel = 'user-model'\n"])("never touches an existing shared config (%j)", (original) => {
    fs.mkdirSync(path.join(root, ".codex"));
    const config = path.join(root, ".codex/config.toml");
    fs.writeFileSync(config, original);
    const installer = new Installer({ homeDir: root, platform: "codex" });
    expect(installer.execute().success).toBe(true);
    expect(installer.execute().items.every((item) => item.action === "skip-identical")).toBe(true);
    expect(new Uninstaller({ homeDir: root }).execute().success).toBe(true);
    expect(fs.readFileSync(config, "utf-8")).toBe(original);
  });

  it("creates no shared config and retires legacy manifest entries", () => {
    expect(new Installer({ homeDir: root, platform: "codex" }).execute().success).toBe(true);
    // Codex 通过 .codex/agents/*.toml 自动发现角色，不需要 config.toml
    expect(fs.existsSync(path.join(root, ".codex/config.toml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".codex/agents/correctness-reviewer.toml"))).toBe(true);

    // 旧版清单残留的注册条目，应在重新安装时退役
    const manifest = ManifestManager.load(root)!;
    manifest.files.push({
      path: ".codex/config.toml", hash: "a".repeat(64), platform: "codex",
      installedAt: manifest.installedAt, sharedConfig: true, originalContent: ""
    });
    ManifestManager.save(root, manifest);
    expect(new Installer({ homeDir: root, platform: "codex" }).execute().success).toBe(true);
    expect(ManifestManager.load(root)!.files.map((f) => f.path)).not.toContain(".codex/config.toml");
  });

  it("upgrades an older single-platform manifest without losing file ownership", () => {
    const options = { workspaceRoot: repo, scope: "local" as const, platform: "antigravity" as const };
    new Installer(options).execute();
    const manifest = ManifestManager.load(repo)!;
    fs.writeFileSync(ManifestManager.getManifestPath(repo), JSON.stringify({
      schemaVersion: "1.0.0", packageVersion: "0.1.0", platform: "antigravity",
      installedAt: manifest.installedAt, updatedAt: manifest.updatedAt,
      files: manifest.files.map(({ path, hash, installedAt }) => ({ path, hash, installedAt }))
    }));
    expect(new Installer(options).execute().success).toBe(true);
    expect(ManifestManager.load(repo)?.platforms).toEqual(["antigravity"]);
    expect(new Uninstaller({ workspaceRoot: repo, scope: "local" }).execute().success).toBe(true);
  });

  it("removes a shared config only when this installation created it", () => {
    new Installer({ homeDir: root, platform: "codex" }).execute();
    expect(new Uninstaller({ homeDir: root }).execute().success).toBe(true);
    expect(fs.existsSync(path.join(root, ".codex/config.toml"))).toBe(false);
  });

  it("leaves a legacy shared config untouched during forced uninstall", () => {
    new Installer({ homeDir: root, platform: "codex" }).execute();
    // 模拟旧版清单记录了 config.toml，且 originalContent === null
    // （旧语义下这意味着「由本工具创建」，会被直接删除）
    const manifest = ManifestManager.load(root)!;
    manifest.files.push({
      path: ".codex/config.toml", hash: ManifestManager.computeHash("merged"),
      platform: "codex", installedAt: manifest.installedAt, sharedConfig: true, originalContent: null
    });
    ManifestManager.save(root, manifest);

    const config = path.join(root, ".codex/config.toml");
    fs.writeFileSync(config, "# user edited\n");
    const before = fs.readFileSync(config, "utf-8");

    const result = new Uninstaller({ homeDir: root, force: true }).execute();
    expect(result.success).toBe(true);
    expect(result.manualCleanup).toContain(".codex/config.toml");
    expect(fs.readFileSync(config, "utf-8")).toBe(before);
    expect(fs.existsSync(path.join(root, ".agent-code-review.json"))).toBe(false);
  });

  it.each([
    'agents = { correctness_reviewer = { description = "user" } }\n',
    '[agents."security_reviewer"]\ndescription = "user"\n',
    'model = "unterminated\n'
  ])("leaves unparseable or user-owned Codex config untouched (%j)", (original) => {
    fs.mkdirSync(path.join(root, ".codex"));
    const config = path.join(root, ".codex/config.toml");
    fs.writeFileSync(config, original);
    expect(new Installer({ homeDir: root, platform: "codex", force: true }).execute().success).toBe(true);
    expect(fs.readFileSync(config, "utf-8")).toBe(original);
  });

  it("reports legacy shared configs for manual cleanup instead of restoring them", () => {
    const config = path.join(root, ".codex/config.toml");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = 'model = "x"\n';
    fs.writeFileSync(config, original);
    new Installer({ homeDir: root, platform: "codex" }).execute();
    const manifest = ManifestManager.load(root)!;
    manifest.files.push({
      path: ".codex/config.toml", hash: ManifestManager.computeHash("merged"),
      platform: "codex", installedAt: manifest.installedAt
    });
    ManifestManager.save(root, manifest);

    const result = new Uninstaller({ homeDir: root, force: true }).execute();
    expect(result.manualCleanup).toContain(".codex/config.toml");
    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(config, "utf-8")).toBe(original);
  });

  it("blocks traversal and unrecognized paths in an otherwise valid manifest", () => {
    new Installer({ homeDir: repo, platform: "claude-code" }).execute();
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "known");
    const manifest = ManifestManager.load(repo)!;
    manifest.files = [{ path: "../outside.txt", hash: ManifestManager.computeHash("known"), platform: "claude-code", installedAt: manifest.installedAt }];
    ManifestManager.save(repo, manifest);
    const result = new Uninstaller({ homeDir: repo, force: true }).execute();
    expect(result.success).toBe(false);
    expect(result.manifestRemoved).toBe(false);
    expect(fs.readFileSync(outside, "utf-8")).toBe("known");
  });

  it.skipIf(!canSymlink)("blocks symlinked managed directories on install and uninstall", () => {
    const outside = path.join(root, "outside"); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, ".claude"));
    expect(new Installer({ homeDir: repo, platform: "claude-code" }).execute().success).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
    ManifestManager.save(repo, {
      schemaVersion: "1.0.0", packageVersion: "0.1.0", scope: "global", platforms: ["claude-code"],
      installedAt: "now", updatedAt: "now", files: [{ path: ".claude/agents/correctness-reviewer.md", hash: ManifestManager.computeHash("known"), platform: "claude-code", installedAt: "now" }]
    });
    fs.mkdirSync(path.join(outside, "agents"));
    fs.writeFileSync(path.join(outside, "agents/correctness-reviewer.md"), "known");
    expect(new Uninstaller({ homeDir: repo, force: true }).execute().success).toBe(false);
    expect(fs.readFileSync(path.join(outside, "agents/correctness-reviewer.md"), "utf-8")).toBe("known");
  });

  it("supports local all-platform installation without shared skill conflicts", () => {
    const options = { workspaceRoot: repo, scope: "local" as const, platform: "all" as const };
    expect(new Installer(options).execute().success).toBe(true);
    expect(new Installer(options).execute().success).toBe(true);
    expect(new Uninstaller({ workspaceRoot: repo, scope: "local" }).execute().success).toBe(true);
  });

  it("counts confirmed severities separately from pending findings", () => {
    const summary = ReviewReporter.buildSummary([{ ...finding, status: "CONFIRMED" }, { ...finding, id: "pending", severity: "P1" }]);
    expect(summary.confirmed).toBe(1); expect(summary.needs_verification).toBe(1);
    expect(summary.by_severity).toEqual({ P0: 0, P1: 0, P2: 1, P3: 0 });
  });

  it.each([{ evidence: [42] }, { start_line: NaN }, { end_line: Infinity }, { verification: { method: "invented", tests_executed: false } }])("rejects invalid protocol data %j", (invalid) => {
    expect(validateFinding({ ...finding, ...invalid }).valid).toBe(false);
  });

  // ---- 跨平台路径归一化（D-01）与卸载删除边界（C.1/C.2）----

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "emits POSIX-only relative paths for %s that satisfy the managed-path allowlist", (platform) => {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true, homeDir: root });
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(f.relativePath).not.toContain("\\");
        expect(() => resolveManagedPath(root, f.relativePath)).not.toThrow();
      }
    }
  );

  it("installs and uninstalls cleanly when the Antigravity CLI directory exists", () => {
    fs.mkdirSync(path.join(root, ".gemini/antigravity-cli"), { recursive: true });
    const skill = ".gemini/antigravity-cli/skills/code-review/SKILL.md";

    const plan = getAdapter("antigravity").getTemplateFiles({ isGlobal: true, homeDir: root });
    expect(plan.map((f) => f.relativePath)).toContain(skill);

    expect(new Installer({ homeDir: root, platform: "antigravity" }).execute().success).toBe(true);
    expect(fs.existsSync(path.join(root, skill))).toBe(true);

    const result = new Uninstaller({ homeDir: root }).execute();
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(root, skill))).toBe(false);
    // manifest 必须一并清除，否则卸载将永久失败
    expect(fs.existsSync(path.join(root, ".agent-code-review.json"))).toBe(false);
  });

  it("keeps host-owned directories but removes tool-private ones on uninstall", () => {
    expect(new Installer({ homeDir: root, platform: "all" }).execute().success).toBe(true);
    expect(new Uninstaller({ homeDir: root }).execute().success).toBe(true);

    // 宿主共享目录：即使为空也必须存活
    for (const hostDir of [".claude", ".codex", ".gemini"]) {
      expect(fs.existsSync(path.join(root, hostDir)), `${hostDir} 不应被卸载删除`).toBe(true);
    }
    // 工具私有目录应被清理，不留空文件夹
    expect(fs.existsSync(path.join(root, ".agents"))).toBe(false);
    for (const role of ["correctness-reviewer", "security-reviewer", "concurrency-reviewer", "performance-reviewer", "findings-verifier"]) {
      expect(fs.existsSync(path.join(root, ".gemini/config/agents", role)), `${role} 角色目录应被清理`).toBe(false);
    }
    expect(fs.existsSync(path.join(root, ".gemini/config/agents")), ".gemini/config/agents 宿主目录应保留").toBe(true);
  });

  it("keeps host-owned directories in a local workspace too", () => {
    const opts = { workspaceRoot: repo, scope: "local" as const, platform: "all" as const };
    expect(new Installer(opts).execute().success).toBe(true);
    expect(new Uninstaller({ workspaceRoot: repo, scope: "local" }).execute().success).toBe(true);

    // <workspace>/.claude 与 <workspace>/.codex 是宿主的项目级配置目录，
    // 不能因为 scope === "local" 就失去保护（见方案 C.1）
    expect(fs.existsSync(path.join(repo, ".claude"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".codex"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".agents"))).toBe(false);
  });
});
