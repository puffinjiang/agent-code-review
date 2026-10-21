import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { TemplateFile } from "../antigravity/index.js";

export class ClaudeCodeAdapter {
  public static readonly platformId = "claude-code";
  public static readonly platformName = "Claude Code";
  public static readonly verified = false;

  public static getTemplateFiles(options: {
    templateRootDir?: string;
    isGlobal?: boolean;
    homeDir?: string;
  } = {}): TemplateFile[] {
    let root = options.templateRootDir;
    if (!root) {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const cand1 = path.resolve(currentDir, "../templates/claude-code");
      const cand2 = path.resolve(currentDir, "../../templates/claude-code");
      if (fs.existsSync(cand1)) {
        root = cand1;
      } else if (fs.existsSync(cand2)) {
        root = cand2;
      } else {
        root = cand1;
      }
    }

    const files: TemplateFile[] = [];

    // Claude Code uses .claude/skills/code-review/SKILL.md and .claude/agents/
    const agentsDest = ".claude/agents";
    const skillsDest = ".claude/skills";

    function collect(dir: string, baseDir: string, destPrefix: string) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          collect(fullPath, baseDir, destPrefix);
        } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".json"))) {
          const relFromBase = path.relative(baseDir, fullPath);
          files.push({
            relativePath: path.join(destPrefix, relFromBase),
            sourceContent: fs.readFileSync(fullPath, "utf-8")
          });
        }
      }
    }

    collect(path.join(root, "agents"), path.join(root, "agents"), agentsDest);
    collect(path.join(root, "skills"), path.join(root, "skills"), skillsDest);

    return files;
  }
}
