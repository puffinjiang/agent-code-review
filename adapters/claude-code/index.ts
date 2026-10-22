import * as path from "node:path";
import { toPosixRelativePath } from "../normalize-path.js";
import { TemplateFile, AdapterOptions, REVIEWER_ROLES } from "../types.js";
import { loadCanonicalPrompt, loadCanonicalSkill } from "../assets-root.js";
import { renderClaudeAgent, renderClaudeSkill } from "../render.js";

export class ClaudeCodeAdapter {
  public static readonly platformId = "claude-code";
  public static readonly platformName = "Claude Code";
  public static readonly verified = false;

  public static getTemplateFiles(options: AdapterOptions = {}): TemplateFile[] {
    const assetsRoot = options.assetsRootDir || options.templateRootDir;
    const files: TemplateFile[] = [];

    // 1. 动态生成 5 个 Reviewer agent 定义: .claude/agents/${role}.md
    for (const role of REVIEWER_ROLES) {
      const prompt = loadCanonicalPrompt(role, assetsRoot);
      const rendered = renderClaudeAgent(role, prompt);
      files.push({
        relativePath: toPosixRelativePath(path.join(".claude/agents", `${role}.md`)),
        sourceContent: rendered
      });
    }

    // 2. 动态生成 code-review Skill 定义: .claude/skills/code-review/SKILL.md
    const skillBody = loadCanonicalSkill(assetsRoot);
    const renderedSkill = renderClaudeSkill(skillBody);
    files.push({
      relativePath: toPosixRelativePath(".claude/skills/code-review/SKILL.md"),
      sourceContent: renderedSkill
    });

    return files;
  }
}
