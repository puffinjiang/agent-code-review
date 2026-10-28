import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  loadCanonicalPrompt,
  loadCanonicalSkill,
  resolveAssetsRoot,
} from "../adapters/assets-root.js";
import { getAdapter } from "../adapters/index.js";
import { validateFinding } from "./helpers/findings.js";

const roles = [
  "correctness-reviewer",
  "security-reviewer",
  "concurrency-reviewer",
  "performance-reviewer",
  "findings-verifier",
] as const;

function parseSimpleYamlFrontmatter(markdown: string): {
  fields: Record<string, string | string[]>;
  body: string;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  expect(match, "Markdown 文件必须包含标准 --- 包裹的 YAML frontmatter 与正文").not.toBeNull();
  const [, rawYaml, body] = match!;
  const fields: Record<string, string | string[]> = {};
  const lines = rawYaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    expect(kv, `无法解析的 YAML 行: ${line}`).not.toBeNull();
    const [, key, rawVal] = kv!;
    if (rawVal === ">-") {
      const folded: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith("  ")) {
        i++;
        folded.push(lines[i].slice(2));
      }
      expect(folded.length, `字段 ${key} 使用 >- 时必须包含缩进内容行`).toBeGreaterThan(0);
      fields[key] = folded.join(" ").trim();
    } else if (rawVal === "") {
      const listItems: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+\S/.test(lines[i + 1])) {
        i++;
        listItems.push(
          lines[i]
            .replace(/^\s*-\s+/, "")
            .replace(/^["']|["']$/g, "")
            .trim(),
        );
      }
      expect(listItems.length, `字段 ${key} 为空值时必须跟随 YAML 块列表项`).toBeGreaterThan(0);
      fields[key] = listItems;
    } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      const inner = rawVal.slice(1, -1).trim();
      fields[key] = inner
        ? inner.split(",").map((item) => item.trim().replace(/^["']|["']$/g, ""))
        : [];
    } else {
      fields[key] = rawVal.trim();
    }
  }
  return { fields, body };
}

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

    const { fields, body } = parseSimpleYamlFrontmatter(agentFile!.sourceContent);
    expect(Object.keys(fields)).toEqual(["name", "description", "tools"]);
    expect(fields.name).toBe(role);
    expect(fields.description.length).toBeGreaterThan(10);
    expect(fields.tools).toBe("Read, Grep, Glob, Bash");
    expect(body.startsWith("# ")).toBe(true);
  });

  it.each(roles)("provides required Antigravity frontmatter: %s", (role) => {
    const globalFiles = getAdapter("antigravity").getTemplateFiles({ isGlobal: true });
    const globalAgentFile = globalFiles.find(
      (f) => f.relativePath === `.gemini/config/agents/${role}/agent.md`,
    );
    expect(globalAgentFile, `缺少 Antigravity 全局 agent 文件: ${role}`).toBeDefined();

    const localFiles = getAdapter("antigravity").getTemplateFiles({ isGlobal: false });
    const localAgentFile = localFiles.find(
      (f) => f.relativePath === `.agents/agents/${role}/agent.md`,
    );
    expect(localAgentFile, `缺少 Antigravity 本地 agent 文件: ${role}`).toBeDefined();
    expect(localAgentFile!.sourceContent).toBe(globalAgentFile!.sourceContent);

    const { fields, body } = parseSimpleYamlFrontmatter(globalAgentFile!.sourceContent);
    expect(Object.keys(fields)).toEqual(["name", "description"]);
    expect(fields.name).toBe(role);
    expect(fields.description.length).toBeGreaterThan(10);
    expect(body.startsWith("# ")).toBe(true);
  });

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "embeds a schema-valid example and uncertainty rules in every %s reviewer",
    (platform) => {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      for (const role of roles) {
        const agentFile = files.find(
          (f) =>
            f.relativePath.includes(role) &&
            (f.relativePath.endsWith(".md") || f.relativePath.endsWith(".toml")),
        );
        expect(agentFile, `未找到 ${platform} 的 ${role} 文件`).toBeDefined();

        const raw = agentFile!.sourceContent;
        const instructions =
          platform === "codex" ? (parse(raw).developer_instructions as string) : raw;
        const jsonBlocks = Array.from(instructions.matchAll(/```json\n([\s\S]*?)\n```/g));
        expect(jsonBlocks).toHaveLength(1);
        const examples = JSON.parse(jsonBlocks[0][1]);
        expect(Array.isArray(examples)).toBe(true);
        expect(examples.length).toBeGreaterThan(0);
        const repoRoot = path.resolve(resolveAssetsRoot(), "..");
        for (const item of examples) {
          expect(validateFinding(item)).toEqual({ valid: true, errors: [] });
          // 示例必须使用中立的 example/ 虚构路径，不得指向本仓库真实存在的文件或目录前缀
          expect(item.file.startsWith("example/")).toBe(true);
          expect(fs.existsSync(path.resolve(repoRoot, item.file))).toBe(false);
          if (item.root_cause_key !== undefined) {
            const esc = item.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            expect(item.root_cause_key).toMatch(new RegExp(`^${esc}:[^:]+:[^:]+$`));
          }
          // 静态分析未运行测试时，不得在 impact 中编造具体耗时数值
          if (!item.verification.tests_executed) {
            expect(item.impact).not.toMatch(/\b\d+(\.\d+)?\s*(ms|s|sec|seconds?|minutes?)\b/i);
          }
        }

        if (role === "concurrency-reviewer") {
          expect(examples[0].recommendation).not.toMatch(/roll\s*back/i);
        }

        if (role === "findings-verifier") {
          expect(examples.map((item: { status: string }) => item.status)).toEqual([
            "CONFIRMED",
            "REJECTED",
            "NEEDS_VERIFICATION",
          ]);
          expect(examples.map((item: { id: string }) => item.id)).toEqual([
            "corr-001",
            "sec-001",
            "perf-001",
          ]);
          expect(examples[0].merged_from).toEqual(["conc-002"]);
          expect(examples[0].verification).not.toHaveProperty("counter_evidence");
          expect(examples[1].verification.counter_evidence).toBeTypeOf("string");
          expect(examples[2].verification.notes).toBeTypeOf("string");
          expect(instructions).toContain("Preserve candidate IDs");
          expect(instructions).toContain("merged_from");
          expect(instructions).toContain("## Verifier output contract");
          expect(instructions).toContain("Return one verdict for every candidate");
          expect(instructions).toContain(
            "You are the sole role permitted to set CONFIRMED or REJECTED",
          );
        } else {
          const expectedCategory = role.replace("-reviewer", "");
          expect(examples[0].category).toBe(expectedCategory);
          expect(examples[0].status).toBe("NEEDS_VERIFICATION");
          const prefixMap: Record<string, string> = {
            "correctness-reviewer": "corr-",
            "security-reviewer": "sec-",
            "concurrency-reviewer": "conc-",
            "performance-reviewer": "perf-",
          };
          expect(examples[0].id.startsWith(prefixMap[role])).toBe(true);
          expect(examples[0]).not.toHaveProperty("merged_from");
          expect(instructions).toMatch(/\b[Rr]eturn \[\]/);
          expect(instructions).not.toContain("CONFIRMED");
          expect(instructions).not.toContain("REJECTED");
          for (const otherRole of roles.filter((other) => other !== role)) {
            expect(instructions).not.toContain(otherRole);
          }
        }

        expect(instructions).toContain("tests actually ran");
        expect(instructions).toContain("intermediate messages");
        expect(instructions).toMatch(/user's language/);
        expect(instructions).not.toMatch(/^## (?:Shared review rules|Review rules)$/m);
        expect(instructions).not.toContain("reachable by an external caller or malicious actor");
      }
    },
  );

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "provides required %s skill frontmatter",
    (platform) => {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      const skillFile = files.find((f) => f.relativePath.endsWith("skills/code-review/SKILL.md"));
      expect(skillFile, `未找到 ${platform} 的 SKILL.md`).toBeDefined();

      const { fields, body } = parseSimpleYamlFrontmatter(skillFile!.sourceContent);
      expect(fields.name).toBe("code-review");
      expect(typeof fields.description === "string" && fields.description.length > 10).toBe(true);
      expect(body.startsWith("# Independent code review")).toBe(true);

      if (platform === "claude-code") {
        expect(Object.keys(fields)).toEqual([
          "name",
          "description",
          "user-invocable",
          "allowed-tools",
        ]);
        expect(fields["user-invocable"]).toBe("true");
        expect(fields["allowed-tools"]).toEqual(["Read", "Grep", "Glob", "Bash", "Agent"]);
      } else {
        expect(Object.keys(fields)).toEqual(["name", "description"]);
      }
    },
  );

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "requires actual independent dispatch and explicit degraded coverage: %s",
    (platform) => {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      const skillFile = files.find((f) => f.relativePath.endsWith("skills/code-review/SKILL.md"));
      expect(skillFile, `未找到 ${platform} 的 SKILL.md`).toBeDefined();

      const skill = skillFile!.sourceContent;
      expect(skill).toContain("Launch each selected reviewer as an independent native subagent");
      expect(skill).toContain("not as personas in one context");
      expect(skill).toContain("separate findings-verifier");
      expect(skill).toContain("single-agent fallback must be labeled");
      expect(skill).toContain("Quick: correctness-reviewer only");
    },
  );

  // 直接断言将要发布到用户主机的产物，而非某个平行实现。
  // 评审规则的事实来源是 assets/skills/code-review.md；规则本身必须按语言无关的方式覆盖。
  it("requires concurrency in standard mode regardless of language extension", () => {
    for (const platform of ["antigravity", "claude-code", "codex"] as const) {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      const skill = files.find((f) =>
        f.relativePath.endsWith("skills/code-review/SKILL.md"),
      )!.sourceContent;

      // 标准模式必须包含 correctness / security / concurrency 三者，与文件扩展名无关
      expect(skill, `${platform} 标准模式应包含 concurrency-reviewer`).toContain(
        "concurrency-reviewer",
      );
      expect(skill).toMatch(
        /Standard:[^\n]*correctness-reviewer[^\n]*security-reviewer[^\n]*concurrency-reviewer/,
      );
      // 不允许按语言扩展名做条件筛选
      expect(skill, `${platform} 不应按文件扩展名条件选择 reviewer`).not.toMatch(
        /only for \.(ts|tsx|py|go)\b/i,
      );
    }
  });

  it("requires aggregation rules that keep distinct causes separate", () => {
    for (const platform of ["antigravity", "claude-code", "codex"] as const) {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      const skill = files.find((f) =>
        f.relativePath.endsWith("skills/code-review/SKILL.md"),
      )!.sourceContent;

      expect(skill, `${platform} 应要求按 root cause + trigger 合并`).toMatch(
        /[Mm]erge only when the root cause and trigger/,
      );
      expect(skill).toMatch(/Retain different triggers and file locations separately/);
      expect(skill).toMatch(/highest supported severity/);
      expect(skill).toContain("sole authoritative result");
    }
  });

  it("requires adversarial verification without silently discarding candidates", () => {
    for (const platform of ["antigravity", "claude-code", "codex"] as const) {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      const skill = files.find((f) =>
        f.relativePath.endsWith("skills/code-review/SKILL.md"),
      )!.sourceContent;

      expect(skill, `${platform} 应要求独立 verifier 溯源与搜索防护机制`).toMatch(
        /Require an independent source trace and a search for guards/,
      );
      expect(skill, `${platform} 严禁静默丢弃 verifier 未能处理的候选缺陷`).toMatch(
        /Do not silently discard candidates that the verifier could not process/,
      );
      expect(skill, `${platform} 应要求在报告前校验候选覆盖完整性`).toContain(
        "Verify completeness before reporting",
      );
    }
  });

  it("requires honest reporting with confirmed/needs_verification/rejected and P0-P3 breakdown", () => {
    for (const platform of ["antigravity", "claude-code", "codex"] as const) {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      const skill = files.find((f) =>
        f.relativePath.endsWith("skills/code-review/SKILL.md"),
      )!.sourceContent;

      expect(skill, `${platform} 应要求如实报告模式、范围、时间戳与文件数`).toMatch(
        /Report mode, scope, timestamp, reviewed file count/,
      );
      expect(skill, `${platform} 应要求输出 P0-P3 严重级别分布`).toContain(
        "confirmed counts with P0-P3 breakdown",
      );
      expect(skill, `${platform} 应区分待验证与已驳回项`).toContain(
        "pending verification count, and rejected count",
      );
    }
  });

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "reports integrity relative to the initial working tree in %s output",
    (platform) => {
      const skillFile = getAdapter(platform)
        .getTemplateFiles({ isGlobal: true })
        .find((file) => file.relativePath.endsWith("skills/code-review/SKILL.md"));
      if (!skillFile) throw new Error(`Missing ${platform} review skill`);
      const skill = skillFile.sourceContent;
      expect(skill).not.toContain("verified clean");
      expect(skill).toContain("Working Tree Before Review");
      expect(skill).toContain("Working Tree After Review");
      expect(skill).toContain("unchanged from baseline | changes detected | not fully verified");
      expect(skill).toContain("Preserve pre-existing edits");
      expect(skill).toContain("captured file contents/hashes with the baseline");
      expect(skill).toContain("not just porcelain path statuses");
      expect(skill).toContain("including already-modified and untracked files");
    },
  );

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "carries configuration-aware Git safety rules into every %s agent and skill",
    (platform) => {
      for (const file of getAdapter(platform).getTemplateFiles({ isGlobal: true })) {
        const instructions = file.relativePath.endsWith(".toml")
          ? (parse(file.sourceContent).developer_instructions as string)
          : file.sourceContent;
        expect(instructions).toMatch(
          /Before (?:the first Git query|Git queries)|For Git queries, inspect/,
        );
        expect(instructions).toContain("do not execute configured helpers");
        expect(instructions).toContain("--no-ext-diff --no-textconv");
        expect(instructions).toContain("-c core.fsmonitor=false");
        expect(instructions).toContain("--no-pager");
        expect(instructions).toContain("untrusted `.git/config`");
        expect(instructions).toContain("report the coverage limitation");
        expect(instructions).toContain("Never modify on-disk Git configuration");
        if (!file.relativePath.endsWith("skills/code-review/SKILL.md")) {
          expect(instructions).toContain(
            "Use only read-only Git queries: diff, show, ls-files, log, status, rev-parse, rev-list, and merge-base",
          );
          expect(instructions).toContain(
            "Never run commands that modify repository files or Git state",
          );
        }
      }
    },
  );

  // ---- 资产寻址与 SSOT 防护（方案 F）----

  it("locates the canonical assets root directory accurately", () => {
    const root = resolveAssetsRoot();
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(path.join(root, "prompts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "skills"))).toBe(true);
  });

  it("ensures assets/prompts/ directly contains strictly canonical reviewer prompts", () => {
    const root = resolveAssetsRoot();
    const promptFiles = fs
      .readdirSync(path.join(root, "prompts"), { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    expect(promptFiles.sort()).toEqual(roles.map((r) => `${r}.md`).sort());
  });

  it.each(roles)("loads canonical prompt for %s successfully", (role) => {
    const prompt = loadCanonicalPrompt(role);
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toMatch(/^# .+\n\n/);
  });

  it.each([
    ["correctness-reviewer", "## Establish the expected behavior", "expected and actual behavior"],
    ["security-reviewer", "## Build the attack path", "actor's existing privileges"],
    ["concurrency-reviewer", "## Construct the schedule", "shared state and its invariant"],
    ["performance-reviewer", "## Build the cost model", "input size, frequency, concurrency"],
    ["findings-verifier", "## Decide", "Return one verdict for every candidate"],
  ] as const)("gives %s its own evidence-producing workflow", (role, heading, evidence) => {
    const prompt = loadCanonicalPrompt(role);
    expect(prompt).toContain(heading);
    expect(prompt).toContain(evidence);
    expect(prompt).not.toContain("## Shared review rules");
    expect(prompt).not.toContain("## Review rules");
  });

  it("loads canonical skill successfully with Orchestrator intent and report skeleton contract", () => {
    const skill = loadCanonicalSkill();
    expect(skill.length).toBeGreaterThan(100);
    expect(skill).toContain("# Independent code review");
    expect(skill).toContain("Code Review Orchestrator");
    expect(skill).toContain(
      "NEVER invent technical findings or override specialized reviewers' technical assessments",
    );
    expect(skill).toContain("Markdown Report Contract Skeleton");
    expect(skill).toContain("git --no-pager -c core.fsmonitor=false status --porcelain");
  });

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "resolves template resources for %s and never returns an empty file set",
    (platform) => {
      const files = getAdapter(platform).getTemplateFiles({ isGlobal: true });
      expect(files.length, `${platform} 模板解析结果为空`).toBeGreaterThan(0);
      // 每个平台都应同时产出 reviewer agent 与 code-review skill
      expect(files.some((f) => /agents?\//.test(f.relativePath))).toBe(true);
      expect(files.some((f) => f.relativePath.endsWith("skills/code-review/SKILL.md"))).toBe(true);
    },
  );

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "throws Fail-Fast error when %s adapter points to a non-existent asset directory",
    (platform) => {
      expect(() =>
        getAdapter(platform).getTemplateFiles({ assetsRootDir: "/tmp/definitely-not-here-acr" }),
      ).toThrow(/指定的资源目录缺失/);
    },
  );

  it.each(["antigravity", "claude-code", "codex"] as const)(
    "throws Fail-Fast error when %s adapter asset directory is completely empty",
    (platform) => {
      const tempEmpty = fs.mkdtempSync(path.join(os.tmpdir(), "acr-empty-ast-"));
      try {
        expect(() => getAdapter(platform).getTemplateFiles({ assetsRootDir: tempEmpty })).toThrow(
          /指定的资源目录缺失/,
        );
      } finally {
        fs.rmSync(tempEmpty, { recursive: true, force: true });
      }
    },
  );
});
