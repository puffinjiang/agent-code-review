import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { TemplateFile } from "../antigravity/index.js";

export class CodexAdapter {
  public static readonly platformId = "codex";
  public static readonly platformName = "OpenAI Codex";
  public static readonly verified = false;

  public static getTemplateFiles(options: {
    templateRootDir?: string;
    isGlobal?: boolean;
    homeDir?: string;
  } = {}): TemplateFile[] {
    let root = options.templateRootDir;
    if (!root) {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const cand1 = path.resolve(currentDir, "../templates/codex");
      const cand2 = path.resolve(currentDir, "../../templates/codex");
      if (fs.existsSync(cand1)) {
        root = cand1;
      } else if (fs.existsSync(cand2)) {
        root = cand2;
      } else {
        root = cand1;
      }
    }

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
            relativePath: path.join(".codex/agents", entry),
            sourceContent: fs.readFileSync(path.join(agentsDir, entry), "utf-8")
          });
        }
      }
    }

    // 3. Config TOML into .codex/config.toml with append merge strategy
    const configPath = path.join(root, "config.toml");
    if (fs.existsSync(configPath)) {
      files.push({
        relativePath: ".codex/config.toml",
        sourceContent: fs.readFileSync(configPath, "utf-8"),
        mergeStrategy: "append-toml-section"
      });
    }

    return files;
  }
}
