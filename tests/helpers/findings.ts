export type Severity = "P0" | "P1" | "P2" | "P3";

export type FindingStatus = "CONFIRMED" | "REJECTED" | "NEEDS_VERIFICATION";

export type FindingCategory =
  | "correctness"
  | "security"
  | "concurrency"
  | "performance"
  | "architecture";

export type FindingOrigin =
  | "introduced"
  | "pre-existing-exposed"
  | "pre-existing-unrelated";

export interface VerificationEvidence {
  method: "static-analysis" | "trace" | "test-execution" | "adversarial-proof";
  tests_executed: boolean;
  notes?: string;
  counter_evidence?: string;
}

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  status: FindingStatus;
  category: FindingCategory;
  file: string;
  start_line: number;
  end_line: number;
  trigger: string;
  impact: string;
  evidence: string[];
  recommendation: string;
  origin: FindingOrigin;
  verification: VerificationEvidence;
  root_cause_key?: string;
}

export interface ReviewReportSummary {
  total: number;
  confirmed: number;
  needs_verification: number;
  rejected: number;
  by_severity: Record<Severity, number>;
  by_category: Record<FindingCategory, number>;
}

export interface ReviewReport {
  version: "1.0.0";
  timestamp: string;
  mode: "quick" | "standard" | "deep";
  git_scope: {
    target: string;
    files_changed: string[];
    is_empty: boolean;
  };
  summary: ReviewReportSummary;
  findings: Finding[];
}

export function validateFinding(finding: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!finding || typeof finding !== "object") {
    return { valid: false, errors: ["Finding must be a non-null object"] };
  }

  const f = finding as Partial<Finding>;

  if (!f.id || typeof f.id !== "string") errors.push("id must be a non-empty string");
  if (!f.title || typeof f.title !== "string") errors.push("title must be a non-empty string");

  const validSeverities: Severity[] = ["P0", "P1", "P2", "P3"];
  if (!f.severity || !validSeverities.includes(f.severity)) {
    errors.push(`severity must be one of: ${validSeverities.join(", ")}`);
  }

  const validStatuses: FindingStatus[] = ["CONFIRMED", "REJECTED", "NEEDS_VERIFICATION"];
  if (!f.status || !validStatuses.includes(f.status)) {
    errors.push(`status must be one of: ${validStatuses.join(", ")}`);
  }

  const validCategories: FindingCategory[] = [
    "correctness",
    "security",
    "concurrency",
    "performance",
    "architecture"
  ];
  if (!f.category || !validCategories.includes(f.category)) {
    errors.push(`category must be one of: ${validCategories.join(", ")}`);
  }

  if (!f.file || typeof f.file !== "string") errors.push("file must be a string");
  if (!Number.isInteger(f.start_line) || (f.start_line ?? 0) < 1) errors.push("start_line must be a positive integer");
  if (!Number.isInteger(f.end_line) || (f.end_line ?? 0) < (f.start_line ?? 1)) {
    errors.push("end_line must be a number greater than or equal to start_line");
  }

  if (!f.trigger || typeof f.trigger !== "string") errors.push("trigger must be a string");
  if (!f.impact || typeof f.impact !== "string") errors.push("impact must be a string");
  if (!Array.isArray(f.evidence) || !f.evidence.every((e) => typeof e === "string" && e.trim().length > 0)) errors.push("evidence must be an array of strings");
  if (!f.recommendation || typeof f.recommendation !== "string") errors.push("recommendation must be a string");

  const validOrigins: FindingOrigin[] = ["introduced", "pre-existing-exposed", "pre-existing-unrelated"];
  if (!f.origin || !validOrigins.includes(f.origin)) {
    errors.push(`origin must be one of: ${validOrigins.join(", ")}`);
  }

  if (!f.verification || typeof f.verification !== "object") {
    errors.push("verification must be an object");
  } else {
    if (!["static-analysis", "trace", "test-execution", "adversarial-proof"].includes(f.verification.method)) {
      errors.push("verification.method must be a supported verification method");
    }
    if (typeof f.verification.tests_executed !== "boolean") {
      errors.push("verification.tests_executed must be a boolean");
    }
    if (f.verification.notes !== undefined && typeof f.verification.notes !== "string") {
      errors.push("verification.notes must be a string when provided");
    }
    if (f.verification.counter_evidence !== undefined && typeof f.verification.counter_evidence !== "string") {
      errors.push("verification.counter_evidence must be a string when provided");
    }
    if (
      f.status === "REJECTED" &&
      (typeof f.verification.counter_evidence !== "string" || f.verification.counter_evidence.trim().length === 0)
    ) {
      errors.push("verification.counter_evidence is required when status is REJECTED");
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
