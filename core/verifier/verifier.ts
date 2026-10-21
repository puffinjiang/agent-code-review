import { Finding, FindingStatus, FindingOrigin } from "../schemas/findings.js";

export interface VerificationChallengeInput {
  finding: Finding;
  /** @deprecated Retained for compatibility; this decision helper does not inspect source. */
  fileContent?: string;
  hasExistingProtection?: boolean;
  protectionDetail?: string;
  concreteTriggerPossible?: boolean;
  isIntroducedByDiff?: boolean;
  origin?: FindingOrigin;
  verificationNotes?: string;
}

export interface VerificationOutcome {
  status: FindingStatus;
  origin: FindingOrigin;
  notes: string;
  counterEvidence?: string;
}

export class IndependentVerifier {
  /**
   * Records explicit external evaluation facts. Does not perform source analysis.
   */
  public static evaluateCandidate(input: VerificationChallengeInput): VerificationOutcome {
    const { finding, hasExistingProtection, protectionDetail, concreteTriggerPossible, isIntroducedByDiff } = input;

    const origin = input.origin ?? (isIntroducedByDiff === true ? "introduced" : finding.origin);

    // 1. Check for contradictory counter-evidence: if existing code already handles/guards against this
    if (hasExistingProtection && !protectionDetail?.trim()) {
      return { status: "NEEDS_VERIFICATION", origin,
        notes: "An existing protection was asserted without concrete counter-evidence." };
    }
    if (hasExistingProtection) {
      return {
        status: "REJECTED",
        origin,
        notes: "Finding rejected: Existing guard or protection was identified in the code path.",
        counterEvidence: protectionDetail || "Existing defense mechanism neutralizes the reported trigger."
      };
    }

    // 2. Style, naming, or purely subjective linting without bug trigger
    if (
      !finding.trigger ||
      finding.trigger.trim().length === 0 ||
      concreteTriggerPossible === false
    ) {
      return {
        status: "REJECTED",
        origin,
        notes: "Finding rejected: No plausible trigger scenario could be constructed to produce failure or data corruption.",
        counterEvidence: "The reported condition does not produce runtime failure or security breach."
      };
    }

    if (isIntroducedByDiff === false && origin === "introduced") {
      return { status: "NEEDS_VERIFICATION", origin,
        notes: "Origin conflicts with the external evaluation; specify whether the pre-existing issue is exposed or unrelated." };
    }

    // This helper records an external evaluator's decision; it does not inspect code.
    // Missing verification facts must never be interpreted as a successful trace.
    if (
      concreteTriggerPossible !== true ||
      hasExistingProtection !== false ||
      !finding.evidence.some((e) => e.trim().length > 0)
    ) {
      return {
        status: "NEEDS_VERIFICATION",
        origin,
        notes: "Independent verification is incomplete: supply a reachable trigger, a protection assessment, and concrete evidence."
      };
    }

    // 5. Confirmed valid bug with concrete trigger and verifiable evidence
    return {
      status: "CONFIRMED",
      origin,
      notes: input.verificationNotes || "External evaluator reports a reachable trigger and no neutralizing protection; this helper did not execute a code trace.",
      counterEvidence: undefined
    };
  }

  /**
   * Batch processes findings through verification rules.
   */
  public static verifyBatch(
    findings: Finding[],
    evaluator?: (finding: Finding) => Partial<VerificationChallengeInput>
  ): Finding[] {
    return findings.map((f) => {
      const extra = evaluator ? evaluator(f) : {};
      const outcome = this.evaluateCandidate({
        finding: f,
        ...extra
      });

      return {
        ...f,
        status: outcome.status,
        origin: outcome.origin,
        verification: {
          ...f.verification,
          notes: outcome.notes,
          counter_evidence: outcome.counterEvidence
        }
      };
    });
  }
}
