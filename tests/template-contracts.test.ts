import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse } from "smol-toml";
import { validateFinding } from "./helpers/findings.js";
import { getAdapter } from "../adapters/index.js";
import { resolveAssetsRoot, loadCanonicalPrompt, loadCanonicalSkill } from "../adapters/assets-root.js";

const roles = [
  "correctness-reviewer",
  "security-reviewer",
  "concurrency-reviewer",
  "performance-reviewer",
  "findings-verifier"
] as const;

describe("Installable reviewer contracts (SSOT dynamic rendering)", () => {
  it.each(roles)("registers a parseable Codex role and instruction layer: %s", (role) => {
    // Codex 通过 ~/.codex/agents/*.toml 与 .codex/agents/*.toml 自动发现角色，
    // 无需在 config.toml 中注册。官方要求的三个字段即 name / description /
    // developer_instructions；name 是身份来源，文件名只是约定。
    const files = getAdapter("codex").getTemplateFiles();
    const agentFile = files.find((f) => f.relativePath === `.codex/agents/${role}.toml`);
    expect(agentFile, `缺少 Codex agent 文件: ${role}`).toBeDefined();

    const agent = parse(agentFile!.sourceContent);
    expect(agent.name).toBe(role.replaceAll("-", "_"));
    expect(agent.description).toBeTypeOf("string");
    expect(agent.developer_instructions).toBeTypeOf("string");
    expect(agent).not.toHaveProperty("instructions");
    expect(agent).not.toHaveProperty("model"); // inherit a usable session model
  });

  it.each(roles)("provides required Claude frontmatter: %s", (role) => {
    const files = getAdapter("claude-code").getTemplateFiles();
    const agentFile = files.find((f) => f.relativePath === `.claude/agents/${role}.md`);
    expect(agentFile, `缺少 Claude agent 文件: ${role}`).toBeDefined();

    const agent = agentFile!.sourceContent;
    expect(agent).toMatch(new RegExp(`^---\\nname: ${role}\\n`));
    expect(agent).toMatch(/\ndescription: >-\n  \S/);
    expect(agent).toMatch(/\ntools: Read, Grep, Glob, Bash\n---\n/);
  });

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "embeds a schema-valid example and uncertainty rules in every %s reviewer",
    (platform) => {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      for (const role of roles) {
        const agentFile = files.find((f) =>
          f.relativePath.includes(role) && (f.relativePath.endsWith(".md") || f.relativePath.endsWith(".toml"))
        );
        expect(agentFile, `未找到 ${platform} 的 ${role} 文件`).toBeDefined();

        const raw = agentFile!.sourceContent;
        const instructions = platform === "codex" ? (parse(raw).developer_instructions as string) : raw;
        const example = JSON.parse(instructions.match(/```json\n([\s\S]*?)\n```/)![1]);
        expect(validateFinding(example[0])).toEqual({ valid: true, errors: [] });
        expect(instructions).toContain("Internal jobs");
        expect(instructions).toContain("Candidate reviewers always use NEEDS_VERIFICATION");
        expect(instructions).toContain("tests actually ran");
        expect(instructions).not.toContain("reachable by an external caller or malicious actor");
      }
    }
  );

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "requires actual independent dispatch and explicit degraded coverage: %s",
    (platform) => {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      const skillFile = files.find((f) => f.relativePath.endsWith("skills/code-review/SKILL.md"));
      expect(skillFile, `未找到 ${platform} 的 SKILL.md`).toBeDefined();

      const skill = skillFile!.sourceContent;
      expect(skill).toContain("Launch each selected reviewer as an independent native subagent");
      expect(skill).toContain("separate findings-verifier");
      expect(skill).toContain("single-agent fallback must be labeled");
      expect(skill).toContain("Quick: correctness-reviewer only");
      if (platform === "claude-code") expect(skill).toMatch(/allowed-tools:.*"Agent"/);
    }
  );

  // 直接断言将要发布到用户主机的产物，而非某个平行实现。
  // 评审规则的事实来源是 assets/skills/code-review.md；规则本身必须按语言无关的方式覆盖。
  it("requires concurrency in standard mode regardless of language extension", () => {
    for (const platform of ["antigravity", "claude-code", "codex"] as const) {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      const skill = files.find((f) => f.relativePath.endsWith("skills/code-review/SKILL.md"))!.sourceContent;

      // 标准模式必须包含 correctness / security / concurrency 三者，与文件扩展名无关
      expect(skill, `${platform} 标准模式应包含 concurrency-reviewer`).toContain("concurrency-reviewer");
      expect(skill).toMatch(/Standard:[^\n]*correctness-reviewer[^\n]*security-reviewer[^\n]*concurrency-reviewer/);
      // 不允许按语言扩展名做条件筛选
      expect(skill, `${platform} 不应按文件扩展名条件选择 reviewer`).not.toMatch(/only for \.(ts|tsx|py|go)\b/i);
    }
  });

  it("requires aggregation rules that keep distinct causes separate", () => {
    for (const platform of ["antigravity", "claude-code", "codex"] as const) {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      const skill = files.find((f) => f.relativePath.endsWith("skills/code-review/SKILL.md"))!.sourceContent;

      expect(skill, `${platform} 应要求按 root cause + trigger 合并`).toMatch(/[Mm]erge only when the root cause and trigger/);
      expect(skill).toMatch(/Retain different triggers and file locations separately/);
      expect(skill).toMatch(/highest supported severity/);
    }
  });

  it("requires adversarial verification without silently discarding candidates", () => {
    for (const platform of ["antigravity", "claude-code", "codex"] as const) {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      const skill = files.find((f) => f.relativePath.endsWith("skills/code-review/SKILL.md"))!.sourceContent;

      expect(skill, `${platform} 应要求独立 verifier 溯源与搜索防护机制`).toMatch(/Require an independent source trace and a search for guards/);
      expect(skill, `${platform} 严禁静默丢弃 verifier 未能处理的候选缺陷`).toMatch(/Do not silently discard candidates that the verifier could not process/);
    }
  });

  it("requires honest reporting with confirmed/needs_verification/rejected and P0-P3 breakdown", () => {
    for (const platform of ["antigravity", "claude-code", "codex"] as const) {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      const skill = files.find((f) => f.relativePath.endsWith("skills/code-review/SKILL.md"))!.sourceContent;

      expect(skill, `${platform} 应要求如实报告模式、范围、时间戳与文件数`).toMatch(/Report mode, scope, timestamp, reviewed file count/);
      expect(skill, `${platform} 应要求输出 P0-P3 严重级别分布`).toContain("confirmed counts with P0-P3 breakdown");
      expect(skill, `${platform} 应区分待验证与已驳回项`).toContain("pending verification count, and rejected count");
    }
  });

  // ---- 资产寻址与 SSOT 防护（方案 F）----

  it("locates the canonical assets root directory accurately", () => {
    const root = resolveAssetsRoot();
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(path.join(root, "prompts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "skills"))).toBe(true);
  });

  it.each(roles)("loads canonical prompt for %s successfully", (role) => {
    const prompt = loadCanonicalPrompt(role);
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain("## Shared review rules");
  });

  it("loads canonical skill successfully", () => {
    const skill = loadCanonicalSkill();
    expect(skill.length).toBeGreaterThan(100);
    expect(skill).toContain("# Independent code review");
  });

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "resolves template resources for %s and never returns an empty file set",
    (platform) => {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      expect(files.length, `${platform} 模板解析结果为空`).toBeGreaterThan(0);
      // 每个平台都应同时产出 reviewer agent 与 code-review skill
      expect(files.some((f) => /agents?\//.test(f.relativePath))).toBe(true);
      expect(files.some((f) => f.relativePath.endsWith("skills/code-review/SKILL.md"))).toBe(true);
    }
  );

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "throws Fail-Fast error when %s adapter points to a non-existent asset directory",
    (platform) => {
      expect(() =>
        getAdapter(platform).getTemplateFiles({ assetsRootDir: "/tmp/definitely-not-here-acr" })
      ).toThrow(/指定的资源目录缺失/);
    }
  );

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "throws Fail-Fast error when %s adapter asset directory is completely empty",
    (platform) => {
      const tempEmpty = fs.mkdtempSync(path.join(os.tmpdir(), "acr-empty-ast-"));
      try {
        expect(() =>
          getAdapter(platform).getTemplateFiles({ assetsRootDir: tempEmpty })
        ).toThrow(/指定的资源目录缺失/);
      } finally {
        fs.rmSync(tempEmpty, { recursive: true, force: true });
      }
    }
  );
});
