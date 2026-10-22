import * as path from "node:path";
import { toPosixRelativePath } from "../normalize-path.js";
import { TemplateFile, AdapterOptions, REVIEWER_ROLES } from "../types.js";
import { loadCanonicalPrompt, loadCanonicalSkill } from "../assets-root.js";
import { renderCodexAgent, renderCodexSkill } from "../render.js";

export class CodexAdapter {
  public static readonly platformId = "codex";
  public static readonly platformName = "OpenAI Codex";
  public static readonly verified = false;

  public static getTemplateFiles(options: AdapterOptions = {}): TemplateFile[] {
    const assetsRoot = options.assetsRootDir || options.templateRootDir;
    const files: TemplateFile[] = [];

    // 1. Skill file into .agents/skills/code-review/SKILL.md
    const skillBody = loadCanonicalSkill(assetsRoot);
    const renderedSkill = renderCodexSkill(skillBody);
    files.push({
      relativePath: toPosixRelativePath(".agents/skills/code-review/SKILL.md"),
      sourceContent: renderedSkill
    });

    // 2. Agents TOML into .codex/agents/${role}.toml
    for (const role of REVIEWER_ROLES) {
      const prompt = loadCanonicalPrompt(role, assetsRoot);
      const rendered = renderCodexAgent(role, prompt);
      files.push({
        relativePath: toPosixRelativePath(path.join(".codex/agents", `${role}.toml`)),
        sourceContent: rendered
      });
    }

    return files;
  }
}
