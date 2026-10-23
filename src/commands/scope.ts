import { GitScopeResolver } from "../../core/git/scope.js";

export interface ScopeCommandOptions {
  target?: string;
  json?: boolean;
}

export function runScope(target?: string, options: ScopeCommandOptions = {}): number {
  const resolvedTarget = target || options.target || "uncommitted";
  const resolver = new GitScopeResolver();

  try {
    const result = resolver.resolve({ target: resolvedTarget });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    console.log(`🔍 Git Scope Resolution:`);
    console.log(`   Target: ${result.target}`);
    console.log(`   Summary: ${result.diffSummary}`);
    console.log(`   Is Empty: ${result.isEmpty ? "Yes" : "No"}`);
    if (result.isMergeCommit) {
      console.log(`   Merge Commit: Yes`);
    }

    if (result.changedFiles.length > 0) {
      console.log(`\n📁 Changed Files (${result.changedFiles.length}):`);
      for (const f of result.changedFiles) {
        const isUntracked = result.untrackedFiles.includes(f);
        console.log(`   - ${f}${isUntracked ? " (untracked new file)" : ""}`);
      }
    }

    return 0;
  } catch (err: unknown) {
    console.error(`❌ Scope resolution error: ${(err as Error).message}`);
    return 1;
  }
}
