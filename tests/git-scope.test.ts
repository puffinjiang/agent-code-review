import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GitScopeResolver } from "../core/git/scope.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

describe("Git Scope Resolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acr-git-test-"));
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.name 'Test User'", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.email 'test@example.com'", { cwd: tempDir, stdio: "ignore" });

    execSync("git config commit.gpgsign false", { cwd: tempDir, stdio: "ignore" });

    // Initial commit
    fs.writeFileSync(path.join(tempDir, "base.txt"), "Initial line\n");
    execSync("git add base.txt && git commit -m 'Initial commit'", { cwd: tempDir, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should detect git repository status", () => {
    const resolver = new GitScopeResolver(tempDir);
    expect(resolver.isGitRepo()).toBe(true);

    const nonGitResolver = new GitScopeResolver(os.tmpdir());
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
    execSync("git add staged.txt", { cwd: tempDir, stdio: "ignore" });

    const result = resolver.resolve({ target: "staged" });
    expect(result.isEmpty).toBe(false);
    expect(result.changedFiles).toEqual(["staged.txt"]);
    expect(result.patch).toContain("+staged content");
  });

  it("should resolve specific commit target", () => {
    const resolver = new GitScopeResolver(tempDir);
    fs.writeFileSync(path.join(tempDir, "commit-file.txt"), "v1");
    execSync("git add commit-file.txt && git commit -m 'feat: add commit-file'", {
      cwd: tempDir,
      stdio: "ignore"
    });

    const commitSha = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
    const result = resolver.resolve({ target: commitSha });

    expect(result.isEmpty).toBe(false);
    expect(result.changedFiles).toContain("commit-file.txt");
    expect(result.isMergeCommit).toBe(false);
  });

  it("should detect merge commits", () => {
    const resolver = new GitScopeResolver(tempDir);
    // Create branch feat
    execSync("git checkout -b feat", { cwd: tempDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tempDir, "feat.txt"), "from feat branch");
    execSync("git add feat.txt && git commit -m 'feat: feature file'", { cwd: tempDir, stdio: "ignore" });

    // Switch back to master/main
    const mainBranch = execSync("git branch --show-current", { cwd: tempDir, encoding: "utf-8" }).trim();
    execSync("git checkout -", { cwd: tempDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tempDir, "main.txt"), "from main branch");
    execSync("git add main.txt && git commit -m 'chore: main file'", { cwd: tempDir, stdio: "ignore" });

    // Merge feat into main with --no-ff
    execSync("git merge --no-ff feat -m 'merge feat into main'", { cwd: tempDir, stdio: "ignore" });

    const mergeCommit = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
    const result = resolver.resolve({ target: mergeCommit });

    expect(result.isMergeCommit).toBe(true);
    expect(result.isEmpty).toBe(false);
    expect(result.changedFiles).toContain("feat.txt");
  });
});
