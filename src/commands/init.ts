import { Installer, InstallScope } from "../lib/installer.js";
import { SupportedPlatform, PLATFORMS } from "../../adapters/index.js";
import { detectPlatforms } from "../lib/detect-platform.js";

export interface InitCommandOptions {
  platform?: string;
  global?: boolean;
  local?: boolean;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
}

export function runInit(options: InitCommandOptions = {}): number {
  // Determine scope: Global First by default!
  const scope: InstallScope = options.local ? "local" : "global";

  let platform: SupportedPlatform = (options.platform || "") as SupportedPlatform;

  if (!platform) {
    // Platform detection
    const detected = detectPlatforms();
    const active = detected.filter((d) => d.detected);

    if (active.length === 1) {
      platform = active[0].id as SupportedPlatform;
      console.log(`🤖 Auto-detected active platform: [${active[0].name}] (${active[0].reason})`);
    } else if (active.length > 1) {
      console.log(`🤖 Detected multiple active platforms: ${active.map((a) => a.name).join(", ")}`);
      platform = "all";
      console.log(`⚡ Defaulting to installing for [all] detected platforms.`);
    } else {
      // Default fallback to antigravity
      platform = "antigravity";
      console.log(`ℹ️ Defaulting to platform [Google Antigravity]. (Use --platform <name> to change).`);
    }
  }

  const validPlatforms = ["antigravity", "claude-code", "codex", "all"];
  if (!validPlatforms.includes(platform)) {
    console.error(`❌ Error: Unknown platform '${platform}'. Supported platforms: ${validPlatforms.join(", ")}`);
    return 1;
  }

  console.log(`📦 Initializing Agent Code Review [Scope: ${scope.toUpperCase()}] for [${platform.toUpperCase()}]...`);
  if (options.dryRun) {
    console.log(`🔍 Running in DRY-RUN mode. No files will be modified.`);
  }

  const installer = new Installer({
    scope,
    platform,
    dryRun: options.dryRun,
    force: options.force
  });

  const result = installer.execute();

  if (!result.success) {
    console.error(`❌ Installation failed:`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    return 1;
  }

  console.log(`\n📋 Target Directory: ${result.baseDir}`);
  console.log(`📋 Installation Actions:`);
  for (const item of result.items) {
    const symbol =
      item.action === "create"
        ? "➕"
        : item.action === "update"
          ? "🔄"
          : item.action === "merge"
            ? "🔀"
            : item.action === "skip-identical"
              ? "✔️"
              : "⚠️";
    console.log(`  ${symbol} [${item.action}] [${item.platform}] ${item.relativePath} (${item.reason})`);
  }

  if (result.dryRun) {
    console.log(`\n✨ Dry-run complete. Re-run without --dry-run to apply changes.`);
  } else {
    console.log(`\n✅ Installation successfully completed!`);
    if (scope === "global") {
      console.log(`🌍 Global First: The Code Review workflow is now available across all projects on this machine.`);
    } else {
      console.log(`📁 Local Project: Configuration installed specifically for this workspace.`);
    }
    console.log(`💡 Usage: Type '/code-review' in your agent session to start reviewing changes.`);
  }

  return 0;
}
