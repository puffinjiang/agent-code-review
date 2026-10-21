export type ReviewMode = "quick" | "standard" | "deep";

export interface ReviewerSpec {
  name: string;
  role: string;
  description: string;
  category: "correctness" | "security" | "concurrency" | "performance";
  required: boolean;
}

export interface ReviewPolicy {
  mode: ReviewMode;
  reviewers: ReviewerSpec[];
  runVerifier: boolean;
  maxFindingsPerCategory: number;
}

export const ALL_REVIEWERS: Record<string, ReviewerSpec> = {
  correctness: {
    name: "correctness-reviewer",
    role: "Correctness Reviewer",
    description: "Evaluates business logic, state transitions, null handling, error handling, edge cases, and functional regressions.",
    category: "correctness",
    required: true
  },
  security: {
    name: "security-reviewer",
    role: "Security Reviewer",
    description: "Audits authentication, authorization, IDOR, tenant isolation, injections, SSRF, sensitive data exposure, and insecure defaults.",
    category: "security",
    required: false
  },
  concurrency: {
    name: "concurrency-reviewer",
    role: "Concurrency Reviewer",
    description: "Inspects race conditions, TOCTOU, idempotency, transaction isolation, duplicate queues/retries, and async blocking.",
    category: "concurrency",
    required: false
  },
  performance: {
    name: "performance-reviewer",
    role: "Performance Reviewer",
    description: "Checks N+1 queries, unindexed queries, blocking I/O, memory leaks, and unbounded loops.",
    category: "performance",
    required: false
  }
};

export function resolveReviewPolicy(
  mode: ReviewMode = "standard",
  changedFiles: string[] = []
): ReviewPolicy {
  if (mode === "quick") {
    return {
      mode: "quick",
      reviewers: [ALL_REVIEWERS.correctness],
      runVerifier: true,
      maxFindingsPerCategory: 5
    };
  }

  if (mode === "deep") {
    return {
      mode: "deep",
      reviewers: [
        ALL_REVIEWERS.correctness,
        ALL_REVIEWERS.security,
        ALL_REVIEWERS.concurrency,
        ALL_REVIEWERS.performance
      ],
      runVerifier: true,
      maxFindingsPerCategory: 20
    };
  }

  // Standard mode always includes all three promised dimensions, regardless
  // of language extension (e.g. TSX, C#, Kotlin, PHP, and configuration changes).
  const selected = [ALL_REVIEWERS.correctness, ALL_REVIEWERS.security, ALL_REVIEWERS.concurrency];

  return {
    mode: "standard",
    reviewers: selected,
    runVerifier: true,
    maxFindingsPerCategory: 10
  };
}
