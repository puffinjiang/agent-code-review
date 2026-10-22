import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GitScopeResolver } from "../core/git/scope.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

describe("Git Scope Resolver", () => {
  let tempDir: string;
  // 以独立参数调用 git：Windows cmd.exe 不把单引号当作引号字符，
  // 拼接成命令字符串会传错参数（见 docs/audit-and-remediation.md D-07）。
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: tempDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acr-git-test-"));
    git("init");
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.com");

    git("config", "commit.gpgsign", "false");

    // Initial commit
    fs.writeFileSync(path.join(tempDir, "base.txt"), "Initial line\n");
    git("add", "base.txt");
    git("commit", "-m", "Initial commit");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should detect git repository status", () => {
    const resolver = new GitScopeResolver(tempDir);
    expect(resolver.isGitRepo()).toBe(true);

    expect(new GitScopeResolver(os.tmpdir()).isGitRepo()).toBeTypeOf("boolean");
    // tmpdir might or might not be in git, but a non-existent dir won't be
    const dummyDir = path.join(tempDir, "sub-not-created");
    const nonGitResolver2 = new GitScopeResolver(dummyDir);
    expect(nonGitResolver2.isGitRepo()).toBe(false);
  });

  it("should handle empty diff gracefully", () => {
    const resolver = new GitScopeResolver(tempDir);
    const result = resolver.resolve({ target: "uncommitted" });
    expect(result.isEmpty).toBe(true);
    expect(result.changedFiles).toHaveLength(0);
    expect(result.patch).toBe("");
  });

  it("should include untracked new source files in uncommitted scope", () => {
    const resolver = new GitScopeResolver(tempDir);
    const newFilePath = path.join(tempDir, "src", "new-file.ts");
    fs.mkdirSync(path.dirname(newFilePath), { recursive: true });
    fs.writeFileSync(newFilePath, "export const hello = 'world';\n");

    const result = resolver.resolve({ target: "uncommitted", includeUntracked: true });
    expect(result.isEmpty).toBe(false);
    expect(result.untrackedFiles).toContain("src/new-file.ts");
    expect(result.changedFiles).toContain("src/new-file.ts");
    expect(result.patch).toContain("+export const hello = 'world';");
  });

  it("should resolve staged changes correctly", () => {
    const resolver = new GitScopeResolver(tempDir);
    fs.writeFileSync(path.join(tempDir, "staged.txt"), "staged content");
    git("add", "staged.txt");

    const result = resolver.resolve({ target: "staged" });
    expect(result.isEmpty).toBe(false);
    expect(result.changedFiles).toEqual(["staged.txt"]);
    expect(result.patch).toContain("+staged content");
  });

  it("should resolve specific commit target", () => {
    const resolver = new GitScopeResolver(tempDir);
    fs.writeFileSync(path.join(tempDir, "commit-file.txt"), "v1");
    git("add", "commit-file.txt");
    git("commit", "-m", "feat: add commit-file");

    const commitSha = git("rev-parse", "HEAD");
    const result = resolver.resolve({ target: commitSha });

    expect(result.isEmpty).toBe(false);
    expect(result.changedFiles).toContain("commit-file.txt");
    expect(result.isMergeCommit).toBe(false);
  });

  it("should detect merge commits", () => {
    const resolver = new GitScopeResolver(tempDir);
    // Create branch feat
    git("checkout", "-b", "feat");
    fs.writeFileSync(path.join(tempDir, "feat.txt"), "from feat branch");
    git("add", "feat.txt");
    git("commit", "-m", "feat: feature file");

    // Switch back to master/main
    git("branch", "--show-current");
    git("checkout", "-");
    fs.writeFileSync(path.join(tempDir, "main.txt"), "from main branch");
    git("add", "main.txt");
    git("commit", "-m", "chore: main file");

    // Merge feat into main with --no-ff
    git("merge", "--no-ff", "feat", "-m", "merge feat into main");

    const mergeCommit = git("rev-parse", "HEAD");
    const result = resolver.resolve({ target: mergeCommit });

    expect(result.isMergeCommit).toBe(true);
    expect(result.isEmpty).toBe(false);
    expect(result.changedFiles).toContain("feat.txt");
  });
});
