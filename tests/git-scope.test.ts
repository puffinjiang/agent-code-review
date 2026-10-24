import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitScopeResolver } from "../core/git/scope.js";

describe("Git Scope Resolver", () => {
  let tempDir: string;
  // 以独立参数调用 git：Windows cmd.exe 不把单引号当作引号字符，
  // 拼接成命令字符串会传错参数（见 docs/audit-and-remediation.md D-07）。
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: tempDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  beforeEach(() => {
    tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "acr-git-test-")));
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

  it("should resolve annotated tags without leaking the tag header into changedFiles (D-14)", () => {
    fs.writeFileSync(path.join(tempDir, "tagged.txt"), "tagged content\n");
    git("add", "tagged.txt");
    git("commit", "-m", "feat: tagged change");
    git("tag", "-a", "v9.9.9", "-m", "release notes line");

    const result = new GitScopeResolver(tempDir).resolve({ target: "v9.9.9" });

    expect(result.changedFiles).toEqual(["tagged.txt"]);
    expect(result.patch).not.toContain("release notes line");
    expect(result.patch).not.toMatch(/^tag v9\.9\.9/m);
    expect(result.headCommit).toBe(git("rev-parse", "HEAD"));
  });

  it("should correctly resolve repository-wide scope when executed from a subdirectory", () => {
    // Commit initial file
    fs.writeFileSync(path.join(tempDir, "root.txt"), "root line 1\n");
    git("add", "root.txt");
    git("commit", "-m", "chore: add root file");

    // Create subdirectories
    const subA = path.join(tempDir, "sub-a");
    const subB = path.join(tempDir, "sub-b");
    fs.mkdirSync(subA, { recursive: true });
    fs.mkdirSync(subB, { recursive: true });

    // Untracked file in sub-a, tracked change in root, untracked in sub-b
    fs.writeFileSync(path.join(subA, "tracked-in-a.txt"), "hello\n");
    git("add", "sub-a/tracked-in-a.txt");
    git("commit", "-m", "chore: add tracked-in-a");

    // Modifications
    fs.writeFileSync(path.join(subA, "tracked-in-a.txt"), "hello updated\n");
    fs.writeFileSync(path.join(subB, "untracked-in-b.txt"), "new file in b\n");
    fs.writeFileSync(path.join(tempDir, "untracked-in-root.txt"), "new file in root\n");

    // Execute resolver instantiated with subA as cwd
    const subResolver = new GitScopeResolver(subA);
    expect(subResolver.isGitRepo()).toBe(true);
    expect(path.resolve(subResolver.getRepoRoot())).toBe(path.resolve(tempDir));

    const result = subResolver.resolve({ target: "uncommitted" });

    // Assert all files across the repo are collected with normalized paths relative to repoRoot
    expect(result.changedFiles).toContain("sub-a/tracked-in-a.txt");
    expect(result.changedFiles).toContain("sub-b/untracked-in-b.txt");
    expect(result.changedFiles).toContain("untracked-in-root.txt");

    // Verify patch contains repository-relative paths
    expect(result.patch).toContain("b/sub-a/tracked-in-a.txt");
    expect(result.patch).toContain("b/sub-b/untracked-in-b.txt");
    expect(result.patch).toContain("b/untracked-in-root.txt");
  });

  it("should cap untracked file patch size and omit massive file contents (V-8)", () => {
    const resolver = new GitScopeResolver(tempDir);
    const largeFilePath = path.join(tempDir, "large-untracked.txt");
    // Write 2 MB of text
    fs.writeFileSync(largeFilePath, "a".repeat(2 * 1024 * 1024) + "\n");

    const result = resolver.resolve({
      target: "uncommitted",
      maxUntrackedFileSize: 1 * 1024 * 1024, // 1 MB cap
    });

    expect(result.untrackedFiles).toContain("large-untracked.txt");
    expect(result.changedFiles).toContain("large-untracked.txt");
    // Patch should indicate omission rather than dumping 2MB into memory
    expect(result.patch).toContain("exceeds inline limit (1 MB); content omitted from diff");
    expect(result.patch).not.toContain("a".repeat(1000));
  });

  it("should enforce total untracked patch size cap across multiple files (V-8)", () => {
    const resolver = new GitScopeResolver(tempDir);
    // Create 3 files of 400KB each
    fs.writeFileSync(path.join(tempDir, "file1.txt"), "1".repeat(400 * 1024) + "\n");
    fs.writeFileSync(path.join(tempDir, "file2.txt"), "2".repeat(400 * 1024) + "\n");
    fs.writeFileSync(path.join(tempDir, "file3.txt"), "3".repeat(400 * 1024) + "\n");

    const result = resolver.resolve({
      target: "uncommitted",
      maxTotalUntrackedSize: 600 * 1024, // 600 KB total cap
    });

    expect(result.untrackedFiles).toHaveLength(3);
    // At least one file should hit the total review limit
    expect(result.patch).toContain("Total untracked files review limit");
  });

  it("should handle buffer limit exceeded with clear descriptive error instead of unhandled crash (V-12)", () => {
    const resolver = new GitScopeResolver(tempDir);
    // Test with a tiny maxBuffer in runGit to verify ENOBUFS diagnostic messaging
    // @ts-expect-error test private method error handling
    expect(() => resolver.runGit(["status"], false, 10)).toThrow(
      /Git command output exceeded buffer limit.*Consider scoping review/,
    );
  });
});
