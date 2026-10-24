import { AntigravityAdapter } from "./antigravity/index.js";
import { ClaudeCodeAdapter } from "./claude-code/index.js";
import { CodexAdapter } from "./codex/index.js";

export { loadCanonicalPrompt, loadCanonicalSkill, resolveAssetsRoot } from "./assets-root.js";

export { toPosixRelativePath } from "./normalize-path.js";
export * from "./render.js";
export * from "./types.js";
export { AntigravityAdapter, ClaudeCodeAdapter, CodexAdapter };

export function getAdapter(platform: "antigravity" | "codex" | "claude-code") {
  switch (platform) {
    case "antigravity":
      return AntigravityAdapter;
    case "codex":
      return CodexAdapter;
    case "claude-code":
      return ClaudeCodeAdapter;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
