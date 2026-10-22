import * as fs from "node:fs";
import * as path from "node:path";

const reviewers = "(?:correctness|security|concurrency|performance)-reviewer|findings-verifier";

/**
 * 早期版本曾向用户的 ~/.codex/config.toml 追加 `[agents.*]` 注册块。
 *
 * Codex 现已原生支持 `~/.codex/agents/*.toml` 与 `.codex/agents/*.toml`
 * 自动发现（见官方 agent-configuration/subagents 文档：无需在 config.toml
 * 中注册），因此注册块不再产生。本项目不再写入该文件。
 *
 * 此路径**仅用于识别旧 manifest**，让卸载能给出手动清理指引。安装器永不写入，
 * 卸载器也永不写入或删除用户配置。
 */
export const LEGACY_SHARED_CONFIG = ".codex/config.toml";

const managedPaths = [
  /^\.agent-code-review\.json$/,
  /^\.(?:agents|claude)\/skills\/code-review\/SKILL\.md$/,
  /^\.gemini\/(?:config|antigravity-cli)\/skills\/code-review\/SKILL\.md$/,
  new RegExp(`^\\.claude/agents/(?:${reviewers})\\.md$`),
  new RegExp(`^\\.codex/agents/(?:${reviewers})\\.toml$`),
  new RegExp(`^\\.(?:agents|gemini/config)/agents/(?:${reviewers})/agent\\.md$`),
  new RegExp(`^\\.codex\\/config\\.toml$`)
];

/**
 * 卸载时允许「为空后清理」的目录，相对 baseDir，POSIX 风格。
 *
 * 采用白名单而非黑名单：未列出的目录一律保留，判定失效时偏保守而非偏破坏。
 *
 * 宿主共享目录（`.claude` / `.codex` / `.gemini` 及其子目录）刻意不在此列 ——
 * 见 `docs/audit-and-remediation.md` 方案 C.1。判据是**目录归属**而非 scope：
 * local scope 下 `<workspace>/.claude`、`<workspace>/.codex` 同样是宿主的项目级
 * 配置目录，因此一并受保护。
 */
const cleanableDirs = new Set([
  ".agents",
  ".agents/agents",
  ".agents/skills",
  ".agents/skills/code-review",
  ".claude/skills/code-review",
  ".gemini/config/skills/code-review",
  ".gemini/antigravity-cli/skills/code-review",
  // Antigravity 的 local 布局为 <role>/agent.md，需逐角色登记，否则空目录会残留
  ...["correctness-reviewer", "security-reviewer", "concurrency-reviewer", "performance-reviewer", "findings-verifier"]
    .map((role) => `.agents/agents/${role}`)
]);

/** 该相对目录是否允许在卸载时被清理。始终按 POSIX 风格比较。 */
export function isCleanableDir(relativeDir: string): boolean {
  return cleanableDirs.has(relativeDir.replace(/\\/g, "/"));
}

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