import { AntigravityAdapter } from "./antigravity/index.js";
import { CodexAdapter } from "./codex/index.js";
import { ClaudeCodeAdapter } from "./claude-code/index.js";

export { toPosixRelativePath } from "./normalize-path.js";
export { resolveTemplatesRoot, resolvePlatformTemplates } from "./templates-root.js";
export type { TemplateFile } from "./antigravity/index.js";

export type SupportedPlatform = "antigravity" | "codex" | "claude-code" | "all";

export interface PlatformMetadata {
  id: "antigravity" | "codex" | "claude-code";
  name: string;
  verified: boolean;
  notes?: string;
}

export const PLATFORMS: Record<"antigravity" | "codex" | "claude-code", PlatformMetadata> = {
  antigravity: {
    id: "antigravity",
    name: "Google Antigravity",
    verified: false,
    notes: "Templates and installer are unit-tested; native runtime discovery and review quality have not been validated."
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    verified: false,
    notes: "Configuration follows documented layout; native runtime discovery and review quality have not been validated."
  },
  codex: {
    id: "codex",
    name: "OpenAI Codex",
    verified: false,
    notes: "Configuration follows documented layout; native runtime discovery and review quality have not been validated."
  }
};

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
