import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "smol-toml";
import { validateFinding } from "../core/schemas/findings.js";
import { resolveReviewPolicy } from "../core/policies/modes.js";

const roles = ["correctness-reviewer", "security-reviewer", "concurrency-reviewer", "performance-reviewer", "findings-verifier"];
const read = (file: string) => fs.readFileSync(path.resolve(file), "utf-8");

describe("Installable reviewer contracts (not native runtime tests)", () => {
  it.each(roles)("registers a parseable Codex role and instruction layer: %s", (role) => {
    const config = parse(read("templates/codex/config.toml"));
    const agents = config.agents as Record<string, { config_file: string }>;
    const filename = agents[role.replaceAll("-", "_")].config_file;
    const agent = parse(read(path.join("templates/codex", filename)));
    expect(agent.name).toBe(role.replaceAll("-", "_"));
    expect(agent.description).toBeTypeOf("string");
    expect(agent.developer_instructions).toBeTypeOf("string");
    expect(agent).not.toHaveProperty("instructions");
    expect(agent).not.toHaveProperty("model"); // inherit a usable session model
  });

  it.each(roles)("provides required Claude frontmatter: %s", (role) => {
    const agent = read(`templates/claude-code/agents/${role}.md`);
    expect(agent).toMatch(new RegExp(`^---\\nname: ${role}\\n`));
    expect(agent).toMatch(/\ndescription: >-\n  \S/);
    expect(agent).toMatch(/\ntools: Read, Grep, Glob, Bash\n---\n/);
  });

  it.each(["antigravity", "claude-code", "codex"])("embeds a schema-valid example and uncertainty rules in every %s reviewer", (platform) => {
    for (const role of roles) {
      const file = platform === "antigravity" ? `templates/${platform}/agents/${role}/agent.md`
        : `templates/${platform}/agents/${role}.${platform === "codex" ? "toml" : "md"}`;
      const raw = read(file);
      const instructions = platform === "codex" ? parse(raw).developer_instructions as string : raw;
      const example = JSON.parse(instructions.match(/```json\n([\s\S]*?)\n```/)![1]);
      expect(validateFinding(example[0])).toEqual({ valid: true, errors: [] });
      expect(instructions).toContain("Internal jobs");
      expect(instructions).toContain("Candidate reviewers always use NEEDS_VERIFICATION");
      expect(instructions).toContain("tests actually ran");
      expect(instructions).not.toContain("reachable by an external caller or malicious actor");
    }
  });

  it.each(["antigravity", "claude-code", "codex"])("requires actual independent dispatch and explicit degraded coverage: %s", (platform) => {
    const skill = read(`templates/${platform}/skills/code-review/SKILL.md`);
    expect(skill).toContain("Launch each selected reviewer as an independent native subagent");
    expect(skill).toContain("separate findings-verifier");
    expect(skill).toContain("single-agent fallback must be labeled");
    expect(skill).toContain("Quick: correctness-reviewer only");
    if (platform === "claude-code") expect(skill).toMatch(/allowed-tools:.*"Agent"/);
  });

  it("includes concurrency for standard review regardless of language extension", () => {
    for (const file of ["component.tsx", "service.cs", "Worker.kt", "queue.php", "config.yaml"]) {
      expect(resolveReviewPolicy("standard", [file]).reviewers.map((reviewer) => reviewer.name)).toContain("concurrency-reviewer");
    }
  });
});
