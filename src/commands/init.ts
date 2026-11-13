import { PLATFORM_IDS, type SupportedPlatform } from "../../adapters/index.js";
import { detectPlatforms } from "../lib/detect-platform.js";
import { Installer, type InstallScope } from "../lib/installer.js";
import { getPackageVersion } from "../lib/version.js";

export interface InitCommandOptions {
  platform?: string;
  global?: boolean;
  local?: boolean;
  dryRun?: boolean;
  force?: boolean;
  homeDir?: string;
  workspaceRoot?: string;
}

const VALID_PLATFORMS: readonly SupportedPlatform[] = [...PLATFORM_IDS, "all"];

function getUsageEntries(platforms: readonly string[]): string[] {
  const usages: string[] = [];
  if (platforms.includes("codex")) usages.push("$code-review (Codex)");
  if (platforms.includes("claude-code")) usages.push("/code-review (Claude Code)");
  if (platforms.includes("antigravity")) usages.push("/code-review (Antigravity)");
  return usages;
}

function parseExplicitPlatform(explicitPlatform: string): SupportedPlatform | null {
  if (!(VALID_PLATFORMS as readonly string[]).includes(explicitPlatform)) {
    console.error(
      `❌ Error: Unknown platform '${explicitPlatform}'. Supported platforms: ${VALID_PLATFORMS.join(", ")}`,
    );
    return null;
  }
  return explicitPlatform as SupportedPlatform;
}

function resolveInitPlatform(
  explicitPlatform: string | undefined,
  homeDir?: string,
): SupportedPlatform | null {
  if (explicitPlatform !== undefined) {
    return parseExplicitPlatform(explicitPlatform);
  }

  const detected = detectPlatforms(homeDir);
  const active = detected.filter((d) => d.detected);

  if (active.length === 1) {
    console.log(`🤖 Auto-detected active platform: [${active[0].name}] (${active[0].reason})`);
    return active[0].id as SupportedPlatform;
  }
  if (active.length > 1) {
    console.log(`🤖 Detected multiple active platforms: ${active.map((a) => a.name).join(", ")}`);
    console.log("⚡ Defaulting to installing for [all] detected platforms.");
    return "all";
  }

  console.log("ℹ️ Defaulting to platform [Google Antigravity]. (Use --platform <name> to change).");
  return "antigravity";
}

function executeInstallFlow(mode: "init" | "update", options: InitCommandOptions): number {
  // Determine scope: Global First by default!
  const scope: InstallScope = options.local ? "local" : "global";

  let targetPlatform: SupportedPlatform | undefined;
  let displayPlatformLabel: string;

  if (mode === "update") {
    if (options.platform !== undefined) {
      const parsed = parseExplicitPlatform(options.platform);
      if (!parsed) {
        return 1;
      }
      targetPlatform = parsed;
      displayPlatformLabel = parsed.toUpperCase();
    } else {
      displayPlatformLabel = "MANIFEST PLATFORMS";
    }
  } else {
    const resolved = resolveInitPlatform(options.platform, options.homeDir);
    if (!resolved) {
      return 1;
    }
    targetPlatform = resolved;
    displayPlatformLabel = resolved.toUpperCase();
  }

  const actionLabel = mode === "update" ? "🔄 Updating" : "📦 Initializing";
  console.log(
    `${actionLabel} Agent Code Review [Scope: ${scope.toUpperCase()}] for [${displayPlatformLabel}]...`,
  );
  if (options.dryRun) {
    console.log("🔍 Running in DRY-RUN mode. No files will be modified.");
  }

  const installer = new Installer({
    scope,
    platform: targetPlatform,
    updateExisting: mode === "update",
    dryRun: options.dryRun,
    force: options.force,
    homeDir: options.homeDir,
    workspaceRoot: options.workspaceRoot,
  });

  const result = installer.execute();

  if (!result.success) {
    console.error("❌ Installation failed:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    return 1;
  }

  // 若系统已是完全最新安装状态，给出清晰简洁的已就绪提示，避免刷屏冗余动作
  if (result.alreadyUpToDate) {
    const ver = getPackageVersion();
    const forceFlags: string[] = [];
    if (scope === "local") forceFlags.push("--local");
    const hintPlatform =
      options.platform !== undefined
        ? options.platform
        : mode === "init"
          ? targetPlatform
          : undefined;
    if (hintPlatform !== undefined) forceFlags.push(`--platform ${hintPlatform}`);
    forceFlags.push("--force");

    console.log(
      `\nℹ️  Agent Code Review (v${ver}) 已经安装且已是最新状态 [${result.platforms.join(", ")}]。`,
    );
    console.log(`   所有 ${result.items.length} 个配置文件与当前版本完全一致，无需重复安装。`);
    console.log("\n💡 Usage: 在 agent 会话中输入以下任一方式开始审查:");
    for (const u of getUsageEntries(result.platforms)) {
      console.log(`   → ${u}`);
    }
    console.log("\n💡 提示:");
    console.log("   - 检查配置健康状态: npx agent-code-review doctor");
    console.log(`   - 强制重新覆盖安装: npx agent-code-review ${mode} ${forceFlags.join(" ")}`);
    return 0;
  }

  console.log(`\n📋 Target Directory: ${result.baseDir}`);
  console.log("📋 Installation Actions:");
  for (const item of result.items) {
    const symbol =
      item.action === "create"
        ? "➕"
        : item.action === "update"
          ? "🔄"
          : item.action === "skip-identical"
            ? "✔️"
            : "⚠️";
    console.log(
      `  ${symbol} [${item.action}] [${item.platform}] ${item.relativePath} (${item.reason})`,
    );
  }

  if (result.dryRun) {
    console.log("\n✨ Dry-run complete. Re-run without --dry-run to apply changes.");
  } else {
    console.log("\n✅ Installation successfully completed!");
    if (scope === "global") {
      console.log(
        "🌍 Global First: The Code Review workflow is now available across all projects on this machine.",
      );
    } else {
      console.log("📁 Local Project: Configuration installed specifically for this workspace.");
    }
    // 各平台的 skill 调用前缀不同：Codex 用美元符（$skill-name），
    // Claude Code / Antigravity 用斜杠。详见 learn.chatgpt.com/docs/build-skills
    const usages = getUsageEntries(result.platforms);
    console.log(`💡 Usage: 在 agent 会话中输入以下任一方式开始审查 → ${usages.join("   |   ")}`);
  }

  return 0;
}

export function runInit(options: InitCommandOptions = {}): number {
  return executeInstallFlow("init", options);
}

export function runUpdate(options: InitCommandOptions = {}): number {
  return executeInstallFlow("update", options);
}
