import { Finding, ReviewReport, ReviewReportSummary } from "../schemas/findings.js";

export class ReviewReporter {
  public static buildSummary(findings: Finding[]): ReviewReportSummary {
    const summary: ReviewReportSummary = {
      total: findings.length,
      confirmed: 0,
      needs_verification: 0,
      rejected: 0,
      by_severity: { P0: 0, P1: 0, P2: 0, P3: 0 },
      by_category: {
        correctness: 0,
        security: 0,
        concurrency: 0,
        performance: 0,
        architecture: 0
      }
    };

    for (const f of findings) {
      if (f.status === "CONFIRMED") summary.confirmed++;
      else if (f.status === "NEEDS_VERIFICATION") summary.needs_verification++;
      else if (f.status === "REJECTED") summary.rejected++;

      if (f.status === "CONFIRMED") {
        summary.by_severity[f.severity] = (summary.by_severity[f.severity] || 0) + 1;
        summary.by_category[f.category] = (summary.by_category[f.category] || 0) + 1;
      }
    }

    return summary;
  }

  public static generateReport(data: {
    mode: "quick" | "standard" | "deep";
    target: string;
    filesChanged: string[];
    isEmpty: boolean;
    findings: Finding[];
  }): ReviewReport {
    return {
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      mode: data.mode,
      git_scope: {
        target: data.target,
        files_changed: data.filesChanged,
        is_empty: data.isEmpty
      },
      summary: this.buildSummary(data.findings),
      findings: data.findings
    };
  }

  public static formatMarkdown(report: ReviewReport): string {
    const { summary, git_scope, mode, findings, timestamp } = report;

    if (git_scope.is_empty) {
      return [
        "# 🛡️ Agent Code Review Report",
        "",
        `> **Timestamp:** ${timestamp} | **Mode:** \`${mode}\` | **Scope:** \`${git_scope.target}\``,
        "",
        "### ✅ Git Diff is Empty",
        "",
        "No changed files or uncommitted modifications were found in the specified scope.",
        "",
        "*Note: An empty diff indicates no modifications to review in this scope. It does not certify that the entire repository is free of pre-existing bugs.*"
      ].join("\n");
    }

    const confirmed = findings.filter((f) => f.status === "CONFIRMED");
    const needsVerification = findings.filter((f) => f.status === "NEEDS_VERIFICATION");
    const rejected = findings.filter((f) => f.status === "REJECTED");

    const lines: string[] = [];

    lines.push("# 🛡️ Agent Code Review Report");
    lines.push("");
    lines.push(`> **Timestamp:** ${timestamp} | **Mode:** \`${mode}\` | **Scope:** \`${git_scope.target}\``);
    lines.push(`> **Files in Scope:** ${git_scope.files_changed.length} file(s)`);
    lines.push("");
    lines.push("## 📊 Review Summary");
    lines.push("");
    lines.push("| Status | Count | Severity Breakdown |");
    lines.push("| :--- | :---: | :--- |");
    lines.push(
      `| 🔴 **Confirmed Findings** | **${summary.confirmed}** | P0: ${summary.by_severity.P0}, P1: ${summary.by_severity.P1}, P2: ${summary.by_severity.P2}, P3: ${summary.by_severity.P3} |`
    );
    lines.push(`| 🟡 **Needs Verification** | **${summary.needs_verification}** | Under scrutiny / needs edge-case test |`);
    lines.push(`| ⚪ **Rejected (False Positives)** | **${summary.rejected}** | Refuted by verifier or counter-evidence |`);
    lines.push("");

    if (confirmed.length > 0) {
      lines.push("## 🔴 Confirmed Findings");
      lines.push("");
      for (const f of confirmed) {
        lines.push(`### [${f.severity}] ${f.id}: ${f.title}`);
        lines.push(`- **Location:** \`${f.file}\` (Lines ${f.start_line}-${f.end_line})`);
        lines.push(`- **Category:** \`${f.category}\` | **Origin:** \`${f.origin}\``);
        lines.push(`- **Trigger:** ${f.trigger}`);
        lines.push(`- **Impact:** ${f.impact}`);
        if (f.evidence.length > 0) {
          lines.push("- **Evidence:**");
          for (const ev of f.evidence) {
            lines.push(`  - ${ev}`);
          }
        }
        lines.push(`- **Verifier Assessment:** ${f.verification.notes || "Confirmed through code path trace"}`);
        lines.push(`- **Actionable Recommendation:** ${f.recommendation}`);
        lines.push("");
      }
    } else {
      lines.push("## 🔴 Confirmed Findings");
      lines.push("");
      lines.push("No confirmed bugs found in the reviewed scope.");
      lines.push("");
    }

    if (needsVerification.length > 0) {
      lines.push("## 🟡 Needs Verification (Potential Risks)");
      lines.push("");
      for (const f of needsVerification) {
        lines.push(`### [${f.severity}] ${f.id}: ${f.title}`);
        lines.push(`- **Location:** \`${f.file}\` (Lines ${f.start_line}-${f.end_line})`);
        lines.push(`- **Category:** \`${f.category}\` | **Reason for Hold:** ${f.verification.notes || "Lacks definitive runtime proof"}`);
        lines.push(`- **Recommendation:** ${f.recommendation}`);
        lines.push("");
      }
    }

    if (rejected.length > 0) {
      lines.push("## ⚪ Rejected Findings (False Positives Filtered)");
      lines.push("");
      for (const f of rejected) {
        lines.push(`- **[${f.category}] ${f.title}** (\`${f.file}\`)`);
        lines.push(`  - *Counter-evidence:* ${f.verification.counter_evidence || f.verification.notes}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push(
      "> 🔒 **Default Read-Only Guarantee**: Reviewers must not modify business code or Git history. This formatter does not independently audit filesystem or Git mutations."
    );

    return lines.join("\n");
  }
}
