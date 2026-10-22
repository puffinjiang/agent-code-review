import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse } from "smol-toml";
import { validateFinding } from "../core/schemas/findings.js";
import { resolveReviewPolicy } from "../core/policies/modes.js";
import { getAdapter } from "../adapters/index.js";
import { resolveTemplatesRoot, resolvePlatformTemplates } from "../adapters/templates-root.js";

const roles = ["correctness-reviewer", "security-reviewer", "concurrency-reviewer", "performance-reviewer", "findings-verifier"];
const read = (file: string) => fs.readFileSync(path.resolve(file), "utf-8");

describe("Installable reviewer contracts (not native runtime tests)", () => {
  it.each(roles)("registers a parseable Codex role and instruction layer: %s", (role) => {
    // Codex 通过 ~/.codex/agents/*.toml 与 .codex/agents/*.toml 自动发现角色，
    // 无需在 config.toml 中注册。官方要求的三个字段即 name / description /
    // developer_instructions；name 是身份来源，文件名只是约定。
    const agent = parse(read(path.join("templates/codex/agents", `${role}.toml`)));
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

  // ---- 资源寻址与静默失败防护（D-09 / 方案 F.4）----
  // 静默返回空文件列表会让安装“成功”却零文件落盘，用户误以为已获得保护。
  // 这里的断言就是那道防线。

  it("locates the templates root directory accurately", () => {
    const root = resolveTemplatesRoot();
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(path.join(root, "antigravity"))).toBe(true);
    expect(fs.existsSync(path.join(root, "claude-code"))).toBe(true);
    expect(fs.existsSync(path.join(root, "codex"))).toBe(true);
  });

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "resolves template resources for %s and never returns an empty file set", (platform) => {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      expect(files.length, `${platform} 模板解析结果为空`).toBeGreaterThan(0);
      // 每个平台都应同时产出 reviewer agent 与 code-review skill
      expect(files.some((f) => /agents?\//.test(f.relativePath))).toBe(true);
      expect(files.some((f) => f.relativePath.endsWith("skills/code-review/SKILL.md"))).toBe(true);
    }
  );

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "throws Fail-Fast error when %s adapter points to a non-existent template directory", (platform) => {
      expect(() =>
        getAdapter(platform).getTemplateFiles({ templateRootDir: "/tmp/definitely-not-here-acr" })
      ).toThrow(/模板目录缺失/);
    }
  );

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "throws Fail-Fast error when %s adapter template directory is completely empty", (platform) => {
      const tempEmpty = fs.mkdtempSync(path.join(os.tmpdir(), "acr-empty-tpl-"));
      try {
        expect(() =>
          getAdapter(platform).getTemplateFiles({ templateRootDir: tempEmpty })
        ).toThrow(/模板收集结果为空/);
      } finally {
        fs.rmSync(tempEmpty, { recursive: true, force: true });
      }
    }
  );

  it("resolves platform directory correctly when given the overall templates root", () => {
    const overallRoot = path.resolve("templates");
    const dir = resolvePlatformTemplates("antigravity", overallRoot);
    expect(dir).toBe(path.resolve("templates/antigravity"));
  });

  it("resolves platform directory correctly when given the specific platform directory", () => {
    const specificDir = path.resolve("templates/antigravity");
    const dir = resolvePlatformTemplates("antigravity", specificDir);
    expect(dir).toBe(specificDir);
  });
});
