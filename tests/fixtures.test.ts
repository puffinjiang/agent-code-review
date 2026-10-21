import { describe, it, expect } from "vitest";
import { resolveReviewPolicy } from "../core/policies/modes.js";
import { IndependentVerifier } from "../core/verifier/verifier.js";
import { Finding, validateFinding } from "../core/schemas/findings.js";
import { ReviewReporter } from "../core/reporter/reporter.js";

describe("Handwritten finding protocol examples (not reviewer accuracy evaluation)", () => {
  it("should trigger correctness, security, and concurrency reviewers for complex code files", () => {
    const policy = resolveReviewPolicy("standard", [
      "tests/fixtures/deliberate-bugs.ts"
    ]);
    const reviewerNames = policy.reviewers.map((r) => r.name);
    expect(reviewerNames).toContain("correctness-reviewer");
    expect(reviewerNames).toContain("security-reviewer");
    expect(reviewerNames).toContain("concurrency-reviewer");
  });

  it("should verify and confirm IDOR bug finding when trace demonstrates missing ownership check", () => {
    const idorFinding: Finding = {
      id: "SEC-IDOR-01",
      title: "Insecure Direct Object Reference (IDOR) in getDocument",
      severity: "P1",
      status: "CONFIRMED",
      category: "security",
      file: "tests/fixtures/deliberate-bugs.ts",
      start_line: 11,
      end_line: 16,
      trigger: "Authenticated user supplies arbitrary document id in req.params.id",
      impact: "Unauthorized access to other tenants' documents",
      evidence: ["db.document.findUnique({ where: { id: req.params.id } }) called without tenant_id or user_id constraint"],
      recommendation: "Filter query with where: { id: req.params.id, owner_id: req.user.id }",
      origin: "introduced",
      verification: {
        method: "trace",
        tests_executed: false
      }
    };

    expect(validateFinding(idorFinding).valid).toBe(true);

    const outcome = IndependentVerifier.evaluateCandidate({
      finding: idorFinding,
      hasExistingProtection: false,
      concreteTriggerPossible: true,
      isIntroducedByDiff: true
    });

    expect(outcome.status).toBe("CONFIRMED");
    expect(outcome.origin).toBe("introduced");
  });

  it("should reject candidate bug if calling route has middleware defense", () => {
    const falsePositiveFinding: Finding = {
      id: "SEC-FP-01",
      title: "Unauthenticated access to sensitive settings",
      severity: "P1",
      status: "NEEDS_VERIFICATION",
      category: "security",
      file: "src/admin.ts",
      start_line: 10,
      end_line: 15,
      trigger: "Direct request to /admin/settings",
      impact: "Settings leakage",
      evidence: ["Function does not check req.session directly"],
      recommendation: "Add auth check",
      origin: "introduced",
      verification: { method: "static-analysis", tests_executed: false }
    };

    const outcome = IndependentVerifier.evaluateCandidate({
      finding: falsePositiveFinding,
      hasExistingProtection: true,
      protectionDetail: "Router level middleware `requireAdminAuth` guards all `/admin/*` routes"
    });

    expect(outcome.status).toBe("REJECTED");
    expect(outcome.counterEvidence).toContain("requireAdminAuth");
  });

  it("should generate comprehensive report capturing confirmed vs rejected findings", () => {
    const findings: Finding[] = [
      {
        id: "CORR-01",
        title: "Soft-delete records returned in listActiveUsers",
        severity: "P2",
        status: "CONFIRMED",
        category: "correctness",
        file: "tests/fixtures/deliberate-bugs.ts",
        start_line: 2,
        end_line: 6,
        trigger: "db.user.findMany() called without deleted_at check",
        impact: "Deleted records resurface in active listings",
        evidence: ["Missing deleted_at: null"],
        recommendation: "Add filter deleted_at: null",
        origin: "introduced",
        verification: { method: "static-analysis", tests_executed: false }
      },
      {
        id: "PERF-FP",
        title: "Subjective styling suggestion in loop",
        severity: "P3",
        status: "REJECTED",
        category: "performance",
        file: "tests/fixtures/deliberate-bugs.ts",
        start_line: 20,
        end_line: 22,
        trigger: "None",
        impact: "None",
        evidence: [],
        recommendation: "Refactor loop",
        origin: "pre-existing-unrelated",
        verification: {
          method: "static-analysis",
          tests_executed: false,
          counter_evidence: "No performance degradation measurable"
        }
      }
    ];

    const report = ReviewReporter.generateReport({
      mode: "standard",
      target: "uncommitted",
      filesChanged: ["tests/fixtures/deliberate-bugs.ts"],
      isEmpty: false,
      findings
    });

    expect(report.summary.confirmed).toBe(1);
    expect(report.summary.rejected).toBe(1);

    const md = ReviewReporter.formatMarkdown(report);
    expect(md).toContain("🔴 Confirmed Findings");
    expect(md).toContain("⚪ Rejected Findings (False Positives Filtered)");
    expect(md).toContain("Soft-delete records returned in listActiveUsers");
    expect(md).toContain("Subjective styling suggestion in loop");
  });
});
