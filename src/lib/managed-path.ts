import * as fs from "node:fs";
import * as path from "node:path";

const reviewers = "(?:correctness|security|concurrency|performance)-reviewer|findings-verifier";
const managedPaths = [
  /^\.agent-code-review\.json$/,
  /^\.(?:agents|claude)\/skills\/code-review\/SKILL\.md$/,
  /^\.gemini\/config\/skills\/code-review\/SKILL\.md$/,
  new RegExp(`^\\.claude/agents/(?:${reviewers})\\.md$`),
  new RegExp(`^\\.codex/agents/(?:${reviewers})\\.toml$`),
  new RegExp(`^\\.(?:agents|gemini/config)/agents/(?:${reviewers})/agent\\.md$`),
  /^\.codex\/config\.toml$/
];

/** Validate both the lexical path and every existing component before file I/O. */
export function resolveManagedPath(baseDir: string, relativePath: string): string {
  if (typeof relativePath !== "string" || !managedPaths.some((p) => p.test(relativePath))) {
    throw new Error(`Unrecognized managed path: ${relativePath}`);
  }
  const base = path.resolve(baseDir);
  const full = path.resolve(base, relativePath);
  let current = base;
  for (const component of relativePath.split("/")) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing symbolic link in managed path: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return full;
}
