import * as path from "node:path";
import * as fs from "node:fs";
import { TemplateFile } from "../antigravity/index.js";
import { toPosixRelativePath } from "../normalize-path.js";
import { resolvePlatformTemplates } from "../templates-root.js";

export class CodexAdapter {
  public static readonly platformId = "codex";
  public static readonly platformName = "OpenAI Codex";
  public static readonly verified = false;

  public static getTemplateFiles(options: {
    templateRootDir?: string;
    isGlobal?: boolean;
    homeDir?: string;
  } = {}): TemplateFile[] {
    const root = resolvePlatformTemplates("codex", options.templateRootDir);

    const files: TemplateFile[] = [];

    // 1. Skill file into .agents/skills/code-review/SKILL.md
    const skillPath = path.join(root, "skills/code-review/SKILL.md");
    if (fs.existsSync(skillPath)) {
      files.push({
        relativePath: ".agents/skills/code-review/SKILL.md",
        sourceContent: fs.readFileSync(skillPath, "utf-8")
      });
    }

    // 2. Agents TOML into .codex/agents/
    const agentsDir = path.join(root, "agents");
    if (fs.existsSync(agentsDir)) {
      for (const entry of fs.readdirSync(agentsDir)) {
        if (entry.endsWith(".toml")) {
          files.push({
            relativePath: toPosixRelativePath(path.join(".codex/agents", entry)),
            sourceContent: fs.readFileSync(path.join(agentsDir, entry), "utf-8")
          });
        }
      }
    }

    if (files.length === 0) {
      throw new Error(`平台 '${this.platformId}' 模板收集结果为空（搜索根目录: ${root}），请检查模板文件完整性。`);
    }

    return files;
  }
}
