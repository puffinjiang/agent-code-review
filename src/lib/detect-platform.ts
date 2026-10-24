import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DetectedPlatform {
  id: "antigravity" | "claude-code" | "codex";
  name: string;
  detected: boolean;
  reason: string;
}

/**
 * 判定命令是否在 PATH 中可用。
 *
 * 直接遍历 PATH 而非拼接 `where` / `command -v` 交给 shell：既避免了命令字符串
 * 插值，也省掉每平台三次子进程 spawn。
 */
function hasCommand(cmd: string): boolean {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  return dirs.some((dir) =>
    extensions.some((ext) => {
      try {
        return fs.statSync(path.join(dir, cmd + ext)).isFile();
      } catch {
        return false;
      }
    }),
  );
}

export function detectPlatforms(homedir: string = os.homedir()): DetectedPlatform[] {
  const results: DetectedPlatform[] = [];

  // 1. Google Antigravity
  let agyDetected = false;
  let agyReason = "Not detected";
  if (hasCommand("agy")) {
    agyDetected = true;
    agyReason = "Found 'agy' CLI binary in system PATH";
  } else if (hasCommand("gemini")) {
    agyDetected = true;
    agyReason = "Found 'gemini' CLI binary in system PATH";
  } else {
    // Check actual executable or active CLI installation state
    const agyBin = path.join(homedir, ".gemini/antigravity-cli/bin/agy");
    const agySettings = path.join(homedir, ".gemini/antigravity-cli/settings.json");
    if (fs.existsSync(agyBin) || fs.existsSync(agySettings)) {
      agyDetected = true;
      agyReason = "Found verified Antigravity installation at ~/.gemini/antigravity-cli";
    }
  }
  results.push({
    id: "antigravity",
    name: "Google Antigravity",
    detected: agyDetected,
    reason: agyReason,
  });

  // 2. Claude Code
  let claudeDetected = false;
  let claudeReason = "Not detected";
  if (hasCommand("claude")) {
    claudeDetected = true;
    claudeReason = "Found 'claude' CLI binary in system PATH";
  } else {
    const claudeJson = path.join(homedir, ".claude.json");
    const claudeConfig = path.join(homedir, ".claude");
    if (
      fs.existsSync(claudeJson) ||
      (fs.existsSync(claudeConfig) && fs.readdirSync(claudeConfig).length > 0)
    ) {
      claudeDetected = true;
      claudeReason = "Found verified Claude Code configuration in user home";
    }
  }
  results.push({
    id: "claude-code",
    name: "Claude Code",
    detected: claudeDetected,
    reason: claudeReason,
  });

  // 3. OpenAI Codex
  let codexDetected = false;
  let codexReason = "Not detected";
  if (hasCommand("codex")) {
    codexDetected = true;
    codexReason = "Found 'codex' CLI binary in system PATH";
  } else {
    const codexDir = path.join(homedir, ".codex");
    if (fs.existsSync(codexDir) && fs.existsSync(path.join(codexDir, "config.toml"))) {
      codexDetected = true;
      codexReason = "Found verified Codex configuration at ~/.codex/config.toml";
    }
  }
  results.push({
    id: "codex",
    name: "OpenAI Codex",
    detected: codexDetected,
    reason: codexReason,
  });

  return results;
}
