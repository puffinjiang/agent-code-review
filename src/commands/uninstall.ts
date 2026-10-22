import * as path from "node:path";
import { Uninstaller } from "../lib/uninstaller.js";
import { InstallScope } from "../lib/installer.js";

export interface UninstallCommandOptions {
  global?: boolean;
  local?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

export function runUninstall(options: UninstallCommandOptions = {}): number {
  const scope: InstallScope = options.local ? "local" : "global";

  console.log(`🗑️ Uninstalling [Scope: ${scope.toUpperCase()}] Agent Code Review configuration...`);
  if (options.dryRun) {
    console.log(`🔍 Running in DRY-RUN mode. No files will be deleted.`);
  }

  const uninstaller = new Uninstaller({
    scope,
    dryRun: options.dryRun,
    force: options.force
  });

  const result = uninstaller.execute();

  if (!result.success) {
    console.error(`❌ Uninstallation encountered warnings or errors:`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    if (result.skippedFiles.length > 0) {
      console.log(`\n💡 --force can remove customized ordinary managed files. Shared or unsafe configuration paths are always preserved.`);
    }
    return 1;
  }

  console.log(`\n📋 Target Directory: ${result.baseDir}`);
  console.log(`📋 Removed Managed Entries:`);
  for (const f of result.removedFiles) {
    console.log(`  ➖ ${f}`);
  }

  if (result.manualCleanup.length > 0) {
    console.log(`\n⚠️  Manual cleanup required — these user-owned files were never modified by this run:`);
    for (const f of result.manualCleanup) {
      console.log(`  📝 ${path.join(result.baseDir, f)}`);
    }
    console.log(
      `  An older version of Agent Code Review appended reviewer registrations to this file.\n` +
      `  Codex now auto-discovers agents from .codex/agents/*.toml, so that block is no longer\n` +
      `  needed. To remove it manually, delete everything between the markers:\n` +
      `    # --- BEGIN Agent Code Review ---  …  # --- END Agent Code Review ---`
    );
  }

  if (result.dryRun) {
    console.log(`\n✨ Dry-run complete. Re-run without --dry-run to remove managed files.`);
  } else {
    console.log(`\n✅ Agent Code Review (${scope}) successfully uninstalled.`);
  }

  return 0;
}
