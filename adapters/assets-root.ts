import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewerRole } from "./types.js";

/**
 * 定位 Canonical 资产根目录（assets/）。
 *
 * 继承方案 F.4 的核心原则：
 * 1. 采用多级候选路径探测，适配不同的运行环境（dist 打包后、tsx 直接执行、vitest 等）；
 * 2. 候选路径全部失效时立即抛出显式、可排查的错误，杜绝静默回退；
 * 3. 兼容传入自定义目录或兼容历史命名参数。
 */
export function resolveAssetsRoot(customDir?: string): string {
  if (customDir) {
    const candidates = [
      customDir,
      path.join(customDir, "assets"),
      path.resolve(customDir),
      path.resolve(customDir, "assets"),
    ];

    for (const cand of candidates) {
      if (fs.existsSync(cand) && fs.existsSync(path.join(cand, "prompts"))) {
        return cand;
      }
    }

    throw new Error(
      `指定的资源目录缺失或不完整: '${customDir}'。\n` +
        `期望在该目录下包含 prompts/ 与 skills/ 子目录。`,
    );
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../assets"), // dist/
    path.resolve(here, "../../assets"), // src 树 (adapters/xxx -> root)
    path.resolve(here, "../../../assets"),
  ];

  const hit = candidates.find((p) => fs.existsSync(p) && fs.existsSync(path.join(p, "prompts")));
  if (!hit) {
    throw new Error(
      `无法定位 assets/ 资源目录。已尝试以下路径：\n` +
        candidates.map((p) => `  - ${p}`).join("\n") +
        "\n" +
        `这通常意味着 npm 包构建不完整（assets/ 未被打包）或工作区损坏，请重新安装 agent-code-review。`,
    );
  }

  return hit;
}

/**
 * 读取特定 Reviewer 的 Canonical Markdown 正文。
 */
export function loadCanonicalPrompt(role: ReviewerRole, assetsRoot?: string): string {
  const root = resolveAssetsRoot(assetsRoot);
  const promptFile = path.join(root, "prompts", `${role}.md`);
  if (!fs.existsSync(promptFile)) {
    throw new Error(`Reviewer 提示词文件不存在: ${promptFile}`);
  }
  const content = fs.readFileSync(promptFile, "utf-8");
  if (!content.trim()) {
    throw new Error(`Reviewer 提示词文件内容为空: ${promptFile}`);
  }
  return content;
}

/**
 * 读取 Canonical Skill Markdown 正文。
 */
export function loadCanonicalSkill(assetsRoot?: string): string {
  const root = resolveAssetsRoot(assetsRoot);
  const skillFile = path.join(root, "skills", "code-review.md");
  if (!fs.existsSync(skillFile)) {
    throw new Error(`Skill 核心文件不存在: ${skillFile}`);
  }
  const content = fs.readFileSync(skillFile, "utf-8");
  if (!content.trim()) {
    throw new Error(`Skill 核心文件内容为空: ${skillFile}`);
  }
  return content;
}
