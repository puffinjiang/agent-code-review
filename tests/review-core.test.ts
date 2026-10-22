import { describe, it, expect } from "vitest";
import { resolveReviewPolicy } from "../core/policies/modes.js";
import { FindingsAggregator } from "../core/aggregator/aggregator.js";
import { IndependentVerifier } from "../core/verifier/verifier.js";
import { ReviewReporter } from "../core/reporter/reporter.js";
import { Finding } from "../core/schemas/findings.js";

describe("Review Core Components", () => {
  describe("Policy & Modes", () => {
    it("should resolve quick mode with correctness reviewer only", () => {
      const policy = resolveReviewPolicy("quick", ["src/index.ts"]);
      expect(policy.mode).toBe("quick");
      expect(policy.reviewers).toHaveLength(1);
      expect(policy.reviewers[0].name).toBe("correctness-reviewer");
    });

    it("should resolve standard mode with correctness, security and concurrency for code files", () => {
      const policy = resolveReviewPolicy("standard", ["src/server.ts"]);
      expect(policy.mode).toBe("standard");
      expect(policy.reviewers.map((r) => r.name)).toContain("correctness-reviewer");
      expect(policy.reviewers.map((r) => r.name)).toContain("security-reviewer");
      expect(policy.reviewers.map((r) => r.name)).toContain("concurrency-reviewer");
    });

    it("should resolve deep mode with all reviewers", () => {
      const policy = resolveReviewPolicy("deep", ["src/index.ts"]);
      expect(policy.mode).toBe("deep");
      expect(policy.reviewers).toHaveLength(4);
    });
  });

  describe("Findings Aggregator (Deduplication)", () => {
    const candidateA: Finding = {
      id: "REV-1",
      root_cause_key: "users:search:sql-injection",
      title: "SQL Injection in user search",
      severity: "P2",
      status: "CONFIRMED",
      category: "security",
      file: "src/db/users.ts",
      start_line: 40,
      end_line: 45,
      trigger: "Unsanitized query string passed to raw SQL",
      impact: "Unauthorized data exfiltration",
      evidence: ["query string concatenated on line 42"],
      recommendation: "Use parameterized queries",
      origin: "introduced",
      verification: { method: "static-analysis", tests_executed: false }
    };

    const candidateB: Finding = {
      id: "REV-2",
      root_cause_key: "users:search:sql-injection",
      title: "Direct string interpolation in raw database query",
      severity: "P1", // Higher severity
      status: "CONFIRMED",
      category: "security",
      file: "src/db/users.ts",
      start_line: 42,
      end_line: 48, // Overlapping line range
      trigger: "Unsanitized query string passed to raw SQL",
      impact: "Attacker can execute arbitrary SQL commands",
      evidence: ["db.execute(`SELECT * FROM users WHERE name = '${input}'`)"],
      recommendation: "Bind parameter with db.query(sql, [input])",
      origin: "introduced",
      verification: { method: "trace", tests_executed: false }
    };

    it("should merge the same root cause and trigger, upgrading to highest severity", () => {
      const aggregated = FindingsAggregator.aggregate([candidateA, candidateB]);
      expect(aggregated).toHaveLength(1);
      expect(aggregated[0].severity).toBe("P1");
      expect(aggregated[0].evidence).toHaveLength(2);
      expect(aggregated[0].start_line).toBe(40);
      expect(aggregated[0].end_line).toBe(48);
    });
  });

  describe("Independent Verifier", () => {
    const testFinding: Finding = {
      id: "TEST-01",
      title: "Potential race condition in counter update",
      severity: "P2",
      status: "NEEDS_VERIFICATION",
      category: "concurrency",
      file: "src/counter.ts",
      start_line: 10,
      end_line: 15,
      trigger: "Multiple concurrent increment requests",
      impact: "Counter value lost",
      evidence: ["count = count + 1 without lock"],
      recommendation: "Use atomic increment",
      origin: "introduced",
      verification: { method: "static-analysis", tests_executed: false }
    };

    it("should REJECT finding if existing protection is discovered", () => {
      const outcome = IndependentVerifier.evaluateCandidate({
        finding: testFinding,
        hasExistingProtection: true,
        protectionDetail: "Redis distributed lock acquired at line 8"
      });
      expect(outcome.status).toBe("REJECTED");
      expect(outcome.counterEvidence).toContain("Redis distributed lock");
    });

    it("should mark as NEEDS_VERIFICATION if evidence is missing", () => {
      const noEvidence = { ...testFinding, evidence: [] };
      const outcome = IndependentVerifier.evaluateCandidate({
        finding: noEvidence,
        hasExistingProtection: false,
        concreteTriggerPossible: true,
        isIntroducedByDiff: true
      });
      expect(outcome.status).toBe("NEEDS_VERIFICATION");
    });

    it("should CONFIRM finding when concrete trigger and evidence are verified", () => {
      const outcome = IndependentVerifier.evaluateCandidate({
        finding: testFinding,
        hasExistingProtection: false,
        concreteTriggerPossible: true,
        isIntroducedByDiff: true
      });
      expect(outcome.status).toBe("CONFIRMED");
      expect(outcome.origin).toBe("introduced");
    });
  });

  describe("Review Reporter", () => {
    it("should format empty diff report gracefully", () => {
      const report = ReviewReporter.generateReport({
        mode: "standard",
        target: "uncommitted",
        filesChanged: [],
        isEmpty: true,
        findings: []
      });
      const md = ReviewReporter.formatMarkdown(report);
      expect(md).toContain("Git Diff is Empty");
      expect(md).toContain("does not certify that the entire repository is free of pre-existing bugs");
    });

    it("should format detailed report with summary table and sections", () => {
      const confirmedFinding: Finding = {
        id: "ACR-001",
        title: "Missing authorization check",
        severity: "P1",
        status: "CONFIRMED",
        category: "security",
        file: "src/api.ts",
        start_line: 20,
        end_line: 25,
        trigger: "Anonymous user calls delete endpoint",
        impact: "Any user can delete any resource",
        evidence: ["Endpoint missing @Authorize decorator"],
        recommendation: "Add @Authorize(Role.ADMIN)",
        origin: "introduced",
        verification: { method: "trace", tests_executed: false, notes: "Verified in routes config" }
      };

      const report = ReviewReporter.generateReport({
        mode: "standard",
        target: "origin/main...HEAD",
        filesChanged: ["src/api.ts"],
        isEmpty: false,
        findings: [confirmedFinding]
      });

      const md = ReviewReporter.formatMarkdown(report);
      expect(md).toContain("Confirmed Findings");
      expect(md).toContain("[P1] ACR-001: Missing authorization check");
      expect(md).toContain("Default Read-Only Guarantee");
    });
  });
});
