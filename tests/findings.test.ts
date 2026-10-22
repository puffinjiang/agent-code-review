import { describe, it, expect } from "vitest";
import { validateFinding, Finding } from "./helpers/findings.js";

describe("Findings Schema Validation", () => {
  const validFinding: Finding = {
    id: "ACR-001",
    title: "Unfiltered soft-deleted records exposed in endpoint",
    severity: "P1",
    status: "CONFIRMED",
    category: "correctness",
    file: "src/api/users.ts",
    start_line: 45,
    end_line: 52,
    trigger: "GET /api/users returns records where deleted_at IS NOT NULL",
    impact: "Soft-deleted users appear in search results, violating privacy policy",
    evidence: ["Line 48: db.users.findMany() called without deleted_at condition"],
    recommendation: "Add where: { deleted_at: null } to query filter",
    origin: "introduced",
    verification: {
      method: "trace",
      tests_executed: false,
      notes: "Confirmed that schema defines deleted_at and callers assume soft deletion."
    }
  };

  it("should validate a complete valid finding", () => {
    const result = validateFinding(validFinding);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject findings missing required fields", () => {
    const invalid = { ...validFinding, title: undefined };
    const result = validateFinding(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("title"))).toBe(true);
  });

  it("should reject invalid severity and status values", () => {
    const invalid = { ...validFinding, severity: "CRITICAL", status: "PENDING" };
    const result = validateFinding(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("severity"))).toBe(true);
    expect(result.errors.some((e) => e.includes("status"))).toBe(true);
  });

  it("should reject inverted line numbers", () => {
    const invalid = { ...validFinding, start_line: 100, end_line: 50 };
    const result = validateFinding(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("end_line"))).toBe(true);
  });

  it.each([
    { evidence: [42] },
    { start_line: NaN },
    { end_line: Infinity },
    { verification: { method: "invented", tests_executed: false } }
  ])("should reject invalid protocol data: %j", (invalid) => {
    expect(validateFinding({ ...validFinding, ...invalid } as any).valid).toBe(false);
  });
});
