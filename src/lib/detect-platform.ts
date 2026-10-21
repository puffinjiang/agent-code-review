import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface DetectedPlatform {
  id: "antigravity" | "claude-code" | "codex";
  name: string;
  detected: boolean;
  reason: string;
}

function hasCommand(cmd: string): boolean {
  try {
    const checkCmd = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(checkCmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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
    reason: agyReason
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
    if (fs.existsSync(claudeJson) || (fs.existsSync(claudeConfig) && fs.readdirSync(claudeConfig).length > 0)) {
      claudeDetected = true;
      claudeReason = "Found verified Claude Code configuration in user home";
    }
  }
  results.push({
    id: "claude-code",
    name: "Claude Code",
    detected: claudeDetected,
    reason: claudeReason
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
    reason: codexReason
  });

  return results;
}
