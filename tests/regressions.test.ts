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

  it("preserves special filenames in untracked and staged scopes", () => {
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

  it("reviews a symlink target string rather than its external contents", () => {
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

  it.each(["", "# existing\nmodel = 'user-model'\n"])("restores original shared config byte-for-byte (%j)", (original) => {
    fs.mkdirSync(path.join(root, ".codex"));
    const config = path.join(root, ".codex/config.toml");
    fs.writeFileSync(config, original);
    const installer = new Installer({ homeDir: root, platform: "codex" });
    expect(installer.execute().success).toBe(true);
    expect(installer.execute().items.every((item) => item.action === "skip-identical")).toBe(true);
    const preview = new Uninstaller({ homeDir: root, dryRun: true }).execute();
    expect(preview.success).toBe(true);
    expect(fs.readFileSync(config, "utf-8")).toContain("[agents.correctness_reviewer]");
    expect(new Uninstaller({ homeDir: root }).execute().success).toBe(true);
    expect(fs.readFileSync(config, "utf-8")).toBe(original);
  });

  it("retains the initial restoration data when updating a shared config template", () => {
    fs.mkdirSync(path.join(root, ".codex"));
    const config = path.join(root, ".codex/config.toml");
    const original = 'model = "original"\n';
    fs.writeFileSync(config, original);
    const templateDir = path.join(root, "codex-templates");
    fs.cpSync(path.resolve("templates/codex"), templateDir, { recursive: true });
    const options = { homeDir: root, platform: "codex" as const, templateDir };
    expect(new Installer(options).execute().success).toBe(true);
    fs.appendFileSync(path.join(templateDir, "config.toml"), "\n# next template version\n");
    expect(new Installer(options).execute().success).toBe(true);
    expect(fs.readFileSync(config, "utf-8")).toContain("next template version");
    expect(new Uninstaller({ homeDir: root }).execute().success).toBe(true);
    expect(fs.readFileSync(config, "utf-8")).toBe(original);
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

  it("preserves edits to shared config even during forced uninstall", () => {
    new Installer({ homeDir: root, platform: "codex" }).execute();
    const config = path.join(root, ".codex/config.toml");
    fs.appendFileSync(config, "\n# custom\n");
    const content = fs.readFileSync(config, "utf-8");
    expect(new Installer({ homeDir: root, platform: "codex", force: true }).execute().success).toBe(false);
    const result = new Uninstaller({ homeDir: root, force: true }).execute();
    expect(result.skippedFiles).toContain(".codex/config.toml");
    expect(result.manifestRemoved).toBe(false);
    expect(fs.readFileSync(config, "utf-8")).toBe(content);
  });

  it.each([
    'agents = { correctness_reviewer = { description = "user" } }\n',
    '[agents."security_reviewer"]\ndescription = "user"\n',
    'model = "unterminated\n'
  ])("refuses invalid TOML or existing reviewer ownership without modifying files (%j)", (original) => {
    fs.mkdirSync(path.join(root, ".codex"));
    const config = path.join(root, ".codex/config.toml");
    fs.writeFileSync(config, original);
    expect(new Installer({ homeDir: root, platform: "codex", force: true }).execute().success).toBe(false);
    expect(fs.readFileSync(config, "utf-8")).toBe(original);
    expect(fs.existsSync(path.join(root, ".agents"))).toBe(false);
  });

  it("preserves shared configs from legacy manifests", () => {
    new Installer({ homeDir: root, platform: "codex" }).execute();
    const manifest = ManifestManager.load(root)!;
    const entry = manifest.files.find((file) => file.path === ".codex/config.toml")!;
    delete entry.sharedConfig; delete entry.originalContent;
    ManifestManager.save(root, manifest);
    expect(new Uninstaller({ homeDir: root, force: true }).execute().skippedFiles).toContain(entry.path);
    expect(fs.existsSync(path.join(root, entry.path))).toBe(true);
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

  it("blocks symlinked managed directories on install and uninstall", () => {
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
});
