import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GitScopeOptions {
  cwd?: string;
  target?: string;
  includeUntracked?: boolean;
}

export interface GitScopeResult {
  target: string;
  baseCommit?: string;
  headCommit?: string;
  isMergeCommit: boolean;
  isEmpty: boolean;
  changedFiles: string[];
  untrackedFiles: string[];
  diffSummary: string;
  patch: string;
}

export class GitScopeResolver {
  private cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  private runGit(args: string[]): string {
    try {
      return execFileSync("git", args, {
        cwd: this.cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (err: unknown) {
      const e = err as { stderr?: string; message: string };
      throw new Error(`Git command failed [git ${args.join(" ")}]: ${e.stderr || e.message}`);
    }
  }

  public isGitRepo(): boolean {
    try {
      const res = this.runGit(["rev-parse", "--is-inside-work-tree"]).trim();
      return res === "true";
    } catch {
      return false;
    }
  }

  public resolve(options: GitScopeOptions = {}): GitScopeResult {
    if (!this.isGitRepo()) {
      throw new Error(`Directory is not a git repository: ${this.cwd}`);
    }

    const target = options.target || "uncommitted";
    if (target.startsWith("-") || /[\x00-\x20\x7f]/.test(target)) {
      throw new Error("Git target must be a revision or range, not options or whitespace");
    }
    const includeUntracked = options.includeUntracked !== false;

    let patch = "";
    let changedFiles: string[] = [];
    let untrackedFiles: string[] = [];
    let isMergeCommit = false;
    let baseCommit: string | undefined;
    let headCommit: string | undefined;

    // Detect untracked files
    if (includeUntracked && (target === "uncommitted" || target === "working-tree")) {
      const untrackedOutput = this.runGit(["ls-files", "--others", "--exclude-standard", "-z"]);
      untrackedFiles = untrackedOutput.split("\0").filter(Boolean);
    }

    if (target === "uncommitted" || target === "working-tree") {
      let hasHead = false;
      let newFiles = [...untrackedFiles];
      try {
        this.runGit(["rev-parse", "--verify", "HEAD"]);
        hasHead = true;
      } catch {
        hasHead = false;
      }

      if (hasHead) {
        patch = this.runGit(["diff", "HEAD", "--"]);
        const nameStatus = this.runGit(["diff", "--name-only", "-z", "HEAD", "--"]);
        if (nameStatus.length > 0) {
          changedFiles = nameStatus.split("\0").filter(Boolean);
        }
      } else {
        // Against an empty initial tree, review the current worktree contents of
        // indexed files too, including edits made after staging.
        const indexed = this.runGit(["ls-files", "--cached", "-z"]).split("\0").filter(Boolean);
        newFiles = Array.from(new Set([...indexed, ...untrackedFiles])).filter((file) => {
          try { fs.lstatSync(path.resolve(this.cwd, file)); return true; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        });
        changedFiles = [...newFiles];
      }

      // Append untracked files to changedFiles
      for (const u of untrackedFiles) {
        if (!changedFiles.includes(u)) {
          changedFiles.push(u);
        }
      }

      // Generate diff-like patches for untracked files so reviewers can inspect them
      if (newFiles.length > 0) {
        const untrackedPatches: string[] = [];
        for (const uf of newFiles) {
          const fullPath = path.resolve(this.cwd, uf);
          // Never dereference a worktree symlink while collecting review context.
          try {
            const stat = fs.lstatSync(fullPath);
            if (!stat.isFile() && !stat.isSymbolicLink()) continue;
            const content = stat.isSymbolicLink()
              ? fs.readlinkSync(fullPath)
              : fs.readFileSync(fullPath, "utf-8");
            if (content.includes("\0")) continue; // binary data is not source context
            const lines = content ? content.split("\n") : [];
            if (content.endsWith("\n")) lines.pop();
            const addedLines = lines.map((l) => `+${l}`).join("\n");
            const quoted = JSON.stringify(`b/${uf}`);
            untrackedPatches.push(
              `diff --git ${JSON.stringify(`a/${uf}`)} ${quoted}\nnew file mode ${stat.isSymbolicLink() ? "120000" : "100644"}\n--- /dev/null\n+++ ${quoted}\n${lines.length ? `@@ -0,0 +1,${lines.length} @@\n${addedLines}${content.endsWith("\n") ? "\n" : "\n\\ No newline at end of file\n"}` : ""}`
            );
          } catch (err) {
            throw new Error(`Cannot read worktree file '${uf}': ${(err as Error).message}`);
          }
        }
        if (untrackedPatches.length > 0) {
          patch = patch ? `${patch}\n\n${untrackedPatches.join("\n\n")}` : untrackedPatches.join("\n\n");
        }
      }
    } else if (target === "staged") {
      patch = this.runGit(["diff", "--cached", "--"]);
      const nameStatus = this.runGit(["diff", "--cached", "--name-only", "-z", "--"]);
      if (nameStatus.length > 0) {
        changedFiles = nameStatus.split("\0").filter(Boolean);
      }
    } else if (target.includes("...") || target.includes("..")) {
      // Range comparison e.g. origin/main...HEAD or commitA..commitB
      patch = this.runGit(["diff", target, "--"]);
      const nameStatus = this.runGit(["diff", "--name-only", "-z", target, "--"]);
      if (nameStatus.length > 0) {
        changedFiles = nameStatus.split("\0").filter(Boolean);
      }
    } else {
      // Single commit target (e.g. SHA or HEAD~1)
      try {
        // Check if merge commit (has more than 1 parent)
        const parents = this.runGit(["rev-list", "--parents", "-n", "1", target]).trim().split(" ");
        if (parents.length > 2) {
          isMergeCommit = true;
          baseCommit = parents[1];
          // For merge commits, diff against first parent by default and note merge status
          patch = this.runGit(["diff", `${target}^1`, target, "--"]);
          const nameStatus = this.runGit(["diff", "--name-only", "-z", `${target}^1`, target, "--"]);
          if (nameStatus.length > 0) {
            changedFiles = Array.from(new Set(nameStatus.split("\0").filter(Boolean)));
          }
        } else {
          baseCommit = parents[1];
          patch = this.runGit(["show", "--format=", target, "--"]);
          const nameStatus = this.runGit(["show", "--name-only", "-z", "--format=", target, "--"]);
          if (nameStatus.length > 0) {
            changedFiles = nameStatus.split("\0").filter(Boolean);
          }
        }
        headCommit = this.runGit(["rev-parse", "--verify", `${target}^{commit}`]).trim();
      } catch (err: unknown) {
        throw new Error(`Failed to resolve commit target '${target}': ${(err as Error).message}`);
      }
    }

    const isEmpty = changedFiles.length === 0 && patch.trim().length === 0;

    // Diff summary
    const diffSummary = isEmpty
      ? "No changes detected in the specified scope."
      : `Changed files: ${changedFiles.length} (Untracked: ${untrackedFiles.length}, Merge Commit: ${isMergeCommit})`;

    return {
      target,
      baseCommit,
      headCommit,
      isMergeCommit,
      isEmpty,
      changedFiles,
      untrackedFiles,
      diffSummary,
      patch
    };
  }
}
