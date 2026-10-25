export interface TemplateFile {
  relativePath: string;
  sourceContent: string;
}

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
    verified: true,
    notes:
      "Native agent discovery, subagent delegation, and review workflow validated; review detection precision not benchmarked.",
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    verified: true,
    notes:
      "Native slash command, subagent prompt delegation, and review workflow validated; review detection precision not benchmarked.",
  },
  codex: {
    id: "codex",
    name: "OpenAI Codex",
    verified: true,
    notes:
      "Skill auto-discovery ($code-review), agent configuration, and review workflow validated; review detection precision not benchmarked.",
  },
};

export const REVIEWER_ROLES = [
  "concurrency-reviewer",
  "correctness-reviewer",
  "findings-verifier",
  "performance-reviewer",
  "security-reviewer",
] as const;

export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export const REVIEWER_METADATA: Record<ReviewerRole, { description: string }> = {
  "concurrency-reviewer": {
    description:
      "Specialized subagent for detecting race conditions, TOCTOU, idempotency flaws, duplicate event processing, lock/synchronization flaws, and non-atomic state transitions.",
  },
  "correctness-reviewer": {
    description:
      "Specialized subagent for reviewing business logic correctness, edge cases, state transitions, null handling, error propagation, and regression risks.",
  },
  "findings-verifier": {
    description:
      "Independent Findings Verifier: Adversarially challenges, traces code paths, verifies counter-evidence, and validates candidate findings.",
  },
  "performance-reviewer": {
    description:
      "Specialized subagent for analyzing N+1 queries, unindexed queries, blocking I/O, repeated subprocess spawning, memory leaks, and unbounded loops.",
  },
  "security-reviewer": {
    description:
      "Specialized subagent for auditing authentication, authorization, IDOR, trust-boundary isolation, injections, symlink/file hazards, SSRF, and sensitive data leakage.",
  },
};

export const SKILL_METADATA = {
  name: "code-review",
  description:
    "Independent specialized code review with adversarial verification. Reports unavailable delegation explicitly.",
};

export interface AdapterOptions {
  assetsRootDir?: string;
  templateRootDir?: string; // Backward compatibility alias
  isGlobal?: boolean;
  homeDir?: string;
}
