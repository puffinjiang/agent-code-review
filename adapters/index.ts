import { AntigravityAdapter } from "./antigravity/index.js";
import { CodexAdapter } from "./codex/index.js";
import { ClaudeCodeAdapter } from "./claude-code/index.js";

export { AntigravityAdapter, CodexAdapter, ClaudeCodeAdapter };

export { toPosixRelativePath } from "./normalize-path.js";
export { resolveAssetsRoot, loadCanonicalPrompt, loadCanonicalSkill } from "./assets-root.js";
export * from "./render.js";
export * from "./types.js";

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
