#!/usr/bin/env node
/**
 * 发布前资源校验（D-09 / 方案 F.4）。
 *
 * 模板资源缺失有两种表现：
 *   1. 仓库里就没有       → 本脚本直接失败
 *   2. 被 package.json 的 files 字段漏掉 → 发布后用户静默空安装
 * 两者都在发布前拦截，而不是留给用户在运行期发现。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roles = ["correctness-reviewer", "security-reviewer", "concurrency-reviewer", "performance-reviewer", "findings-verifier"];

const platforms = {
  antigravity: {
    agent: (role) => `agents/${role}/agent.md`,
    skill: "skills/code-review/SKILL.md",
    validate: (raw) => (/^---\r?\nname: /.test(raw) ? null : "缺少 YAML frontmatter 的 name")
  },
  "claude-code": {
    agent: (role) => `agents/${role}.md`,
    skill: "skills/code-review/SKILL.md",
    validate: (raw) => (/^---\r?\nname: /.test(raw) ? null : "缺少 YAML frontmatter 的 name")
  },
  codex: {
    agent: (role) => `agents/${role}.toml`,
    skill: "skills/code-review/SKILL.md",
    // Codex 自动发现 ~/.codex/agents/*.toml，这三个字段是官方要求的必填项
    validate: (raw) => {
      const doc = parse(raw);
      const missing = ["name", "description", "developer_instructions"].filter((k) => !doc[k]);
      return missing.length ? `缺少必填字段: ${missing.join(", ")}` : null;
    }
  }
};

const problems = [];

// 1. package.json 的 files 必须包含 templates，否则发布后资源不会进包
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
if (!(pkg.files || []).includes("templates")) {
  problems.push(`package.json 的 files 字段未包含 "templates" —— 模板不会被打进 npm 包`);
}

// 2. 逐平台校验资源完整性
for (const [platform, spec] of Object.entries(platforms)) {
  const dir = path.join(root, "templates", platform);
  if (!fs.existsSync(dir)) {
    problems.push(`模板目录缺失: templates/${platform}`);
    continue;
  }
  for (const role of roles) {
    const file = path.join(dir, spec.agent(role));
    if (!fs.existsSync(file)) {
      problems.push(`缺少 ${platform} agent: templates/${platform}/${spec.agent(role)}`);
      continue;
    }
    const error = spec.validate(fs.readFileSync(file, "utf-8"));
    if (error) problems.push(`templates/${platform}/${spec.agent(role)}: ${error}`);
  }
  if (!fs.existsSync(path.join(dir, spec.skill))) {
    problems.push(`缺少 ${platform} skill: templates/${platform}/${spec.skill}`);
  }
}

if (problems.length > 0) {
  console.error("❌ 模板资源校验失败：\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

console.log(`✅ 模板资源校验通过（${Object.keys(platforms).length} 个平台 × ${roles.length} 个 reviewer）`);