import * as path from "node:path";
import * as fs from "node:fs";
import { toPosixRelativePath } from "../normalize-path.js";
import { TemplateFile, AdapterOptions, REVIEWER_ROLES } from "../types.js";
import { loadCanonicalPrompt, loadCanonicalSkill } from "../assets-root.js";
import { renderAntigravityAgent, renderAntigravitySkill } from "../render.js";

export type { TemplateFile } from "../types.js";

export class AntigravityAdapter {
  public static readonly platformId = "antigravity";
  public static readonly platformName = "Google Antigravity";
  public static readonly verified = false;

  public static getTemplateFiles(options: AdapterOptions = {}): TemplateFile[] {
    const isGlobal = options.isGlobal !== false; // Global by default
    const assetsRoot = options.assetsRootDir || options.templateRootDir;

    const files: TemplateFile[] = [];

    const agentsDest = isGlobal ? ".gemini/config/agents" : ".agents/agents";
    const skillsDest = isGlobal ? ".gemini/config/skills" : ".agents/skills";

    // 1. 动态生成 5 个 Reviewer agent 定义
    for (const role of REVIEWER_ROLES) {
      const prompt = loadCanonicalPrompt(role, assetsRoot);
      const rendered = renderAntigravityAgent(role, prompt);
      files.push({
        relativePath: toPosixRelativePath(path.join(agentsDest, role, "agent.md")),
        sourceContent: rendered
      });
    }

    // 2. 动态生成 code-review Skill 定义
    const skillBody = loadCanonicalSkill(assetsRoot);
    const renderedSkill = renderAntigravitySkill(skillBody);
    files.push({
      relativePath: toPosixRelativePath(path.join(skillsDest, "code-review/SKILL.md")),
      sourceContent: renderedSkill
    });

    // 3. 若为全局安装且检测到 Antigravity CLI 目录，增加兼容副本
    if (isGlobal && options.homeDir) {
      const agyCliDir = path.join(options.homeDir, ".gemini/antigravity-cli");
      if (fs.existsSync(agyCliDir)) {
        files.push({
          relativePath: toPosixRelativePath(".gemini/antigravity-cli/skills/code-review/SKILL.md"),
          sourceContent: renderedSkill
        });
      }
    }

    return files;
  }
}
