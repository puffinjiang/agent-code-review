import * as path from "node:path";
import * as fs from "node:fs";
import { TemplateFile } from "../antigravity/index.js";
import { toPosixRelativePath } from "../normalize-path.js";
import { resolvePlatformTemplates } from "../templates-root.js";

export class ClaudeCodeAdapter {
  public static readonly platformId = "claude-code";
  public static readonly platformName = "Claude Code";
  public static readonly verified = false;

  public static getTemplateFiles(options: {
    templateRootDir?: string;
    isGlobal?: boolean;
    homeDir?: string;
  } = {}): TemplateFile[] {
    const root = resolvePlatformTemplates("claude-code", options.templateRootDir);

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
            relativePath: toPosixRelativePath(path.join(destPrefix, relFromBase)),
            sourceContent: fs.readFileSync(fullPath, "utf-8")
          });
        }
      }
    }

    collect(path.join(root, "agents"), path.join(root, "agents"), agentsDest);
    collect(path.join(root, "skills"), path.join(root, "skills"), skillsDest);

    if (files.length === 0) {
      throw new Error(`平台 '${this.platformId}' 模板收集结果为空（搜索根目录: ${root}），请检查模板文件完整性。`);
    }

    return files;
  }
}
