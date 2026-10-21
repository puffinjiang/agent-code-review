import { Finding, Severity } from "../schemas/findings.js";

const SEVERITY_ORDER: Record<Severity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3
};

function getHigherSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[a] <= SEVERITY_ORDER[b] ? a : b;
}

export class FindingsAggregator {
  public static aggregate(findings: Finding[]): Finding[] {
    const aggregated: Finding[] = [];

    for (const finding of findings) {
      const matchIndex = aggregated.findIndex((item) => {
        // Proximity is not evidence of a shared cause. Keep locations and distinct
        // triggers separate, including repeated patterns in different files.
        return item.file === finding.file &&
          item.trigger === finding.trigger &&
          item.status === finding.status &&
          item.origin === finding.origin &&
          Boolean(item.root_cause_key) &&
          item.root_cause_key === finding.root_cause_key;
      });

      if (matchIndex === -1) {
        // New unique finding
        aggregated.push({
          ...finding,
          evidence: [...finding.evidence]
        });
      } else {
        // Merge with existing finding
        const existing = aggregated[matchIndex];
        const mergedSeverity = getHigherSeverity(existing.severity, finding.severity);
        const mergedEvidence = Array.from(new Set([...existing.evidence, ...finding.evidence]));

        aggregated[matchIndex] = {
          ...existing,
          title: existing.title.length >= finding.title.length ? existing.title : finding.title,
          severity: mergedSeverity,
          start_line: Math.min(existing.start_line, finding.start_line),
          end_line: Math.max(existing.end_line, finding.end_line),
          impact: `${existing.impact} | ${finding.impact}`,
          evidence: mergedEvidence,
          recommendation: `${existing.recommendation}; ${finding.recommendation}`,
          verification: {
            ...existing.verification,
            notes: existing.verification.notes
              ? `${existing.verification.notes} | ${finding.verification.notes || ""}`
              : finding.verification.notes
          }
        };
      }
    }

    return aggregated;
  }
}
