#!/usr/bin/env node
/**
 * 发布前资产校验（方案 F SSOT 架构校验器）。
 *
 * 校验双重防线：
 * 1. 唯一事实来源（Canonical Source）：assets/ 下的 prompts 与 skills 完整性；
 * 2. 动态渲染输出（Rendered Output）：验证 3 个适配器的动态渲染输出是否符合各宿主规范；
 * 3. 打包完整性：package.json 的 files 字段必须包含 "assets"。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { getAdapter, REVIEWER_ROLES } from "../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

// 1. package.json 的 files 必须包含 assets，否则发布后资源不会进包
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
if (!(pkg.files || []).includes("assets")) {
  problems.push(`package.json 的 files 字段未包含 "assets" —— Canonical 资源不会被打进 npm 包`);
}

// 2. 检查 assets/prompts 与 assets/skills 物理完整性
const assetsDir = path.join(root, "assets");
if (!fs.existsSync(assetsDir)) {
  problems.push("Canonical 根目录缺失: assets/");
} else {
  for (const role of REVIEWER_ROLES) {
    const promptPath = path.join(assetsDir, "prompts", `${role}.md`);
    if (!fs.existsSync(promptPath) || fs.statSync(promptPath).size === 0) {
      problems.push(`缺少或空 Canonical 提示词: assets/prompts/${role}.md`);
    }
  }
  const skillPath = path.join(assetsDir, "skills", "code-review.md");
  if (!fs.existsSync(skillPath) || fs.statSync(skillPath).size === 0) {
    problems.push("缺少或空 Canonical Skill: assets/skills/code-review.md");
  }
}

// 3. 逐平台校验适配器动态渲染质量
const platforms = ["antigravity", "claude-code", "codex"];

for (const platform of platforms) {
  try {
    const adapter = getAdapter(platform);
    const files = adapter.getTemplateFiles({ isGlobal: true, assetsRootDir: assetsDir });
    if (!files || files.length === 0) {
      problems.push(`平台 ${platform} 渲染文件列表为空`);
      continue;
    }

    // 检查是否包含 5 个 reviewer + 1 个 skill
    const agents = files.filter((f) => f.relativePath.endsWith(".toml") || (f.relativePath.includes("agents/") && !f.relativePath.includes("skills/")));
    const skill = files.find((f) => f.relativePath.endsWith("skills/code-review/SKILL.md"));

    if (agents.length < 5) {
      problems.push(`平台 ${platform} 渲染出的 agent 数量不足 5 个 (实际: ${agents.length})`);
    }
    if (!skill) {
      problems.push(`平台 ${platform} 未渲染出 skills/code-review/SKILL.md`);
    }

    // 检查语法规范
    if (platform === "codex") {
      for (const agent of agents) {
        const doc = parse(agent.sourceContent);
        const missing = ["name", "description", "developer_instructions"].filter((k) => !doc[k]);
        if (missing.length) {
          problems.push(`Codex ${agent.relativePath} 缺少必填 TOML 字段: ${missing.join(", ")}`);
        }
      }
    } else {
      for (const agent of agents) {
        if (!/^---\r?\nname: /.test(agent.sourceContent)) {
          problems.push(`${platform} ${agent.relativePath} 缺少 YAML frontmatter`);
        }
      }
    }
  } catch (err) {
    problems.push(`平台 ${platform} 渲染时抛出异常: ${err.message}`);
  }
}

if (problems.length > 0) {
  console.error("❌ 资产与渲染校验失败：\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

console.log(`✅ 资产校验通过（SSOT Canonical 资产完整，3 个平台动态渲染符合规范）`);
