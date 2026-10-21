import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface TemplateFile {
  relativePath: string;
  sourceContent: string;
  mergeStrategy?: "overwrite-unmodified" | "append-toml-section" | "merge-json";
}

export class AntigravityAdapter {
  public static readonly platformId = "antigravity";
  public static readonly platformName = "Google Antigravity";
  public static readonly verified = false;

  public static getTemplateFiles(options: {
    templateRootDir?: string;
    isGlobal?: boolean;
    homeDir?: string;
  } = {}): TemplateFile[] {
    const isGlobal = options.isGlobal !== false; // Global by default
    let root = options.templateRootDir;
    if (!root) {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const cand1 = path.resolve(currentDir, "../templates/antigravity");
      const cand2 = path.resolve(currentDir, "../../templates/antigravity");
      if (fs.existsSync(cand1)) {
        root = cand1;
      } else if (fs.existsSync(cand2)) {
        root = cand2;
      } else {
        root = cand1;
      }
    }

    const files: TemplateFile[] = [];

    const agentsDest = isGlobal ? ".gemini/config/agents" : ".agents/agents";
    const skillsDest = isGlobal ? ".gemini/config/skills" : ".agents/skills";

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

    // If global and antigravity-cli directory exists, add compatibility link/copy to .gemini/antigravity-cli/skills/
    if (isGlobal && options.homeDir) {
      const agyCliDir = path.join(options.homeDir, ".gemini/antigravity-cli");
      if (fs.existsSync(agyCliDir)) {
        const skillSource = path.join(root, "skills/code-review/SKILL.md");
        if (fs.existsSync(skillSource)) {
          files.push({
            relativePath: ".gemini/antigravity-cli/skills/code-review/SKILL.md",
            sourceContent: fs.readFileSync(skillSource, "utf-8")
          });
        }
      }
    }

    return files;
  }
}
