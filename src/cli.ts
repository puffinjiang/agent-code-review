import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runDoctor } from "./commands/doctor.js";
import { runUninstall } from "./commands/uninstall.js";
import { runScope } from "./commands/scope.js";

const program = new Command();

program
  .name("agent-code-review")
  .description("Multi-agent code review framework for AI coding agents (Global First)")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize Agent Code Review configuration (Global First by default)")
  .option("-g, --global", "Install into user global Agent configuration directory (Default)", true)
  .option("-l, --local", "Install into current project workspace instead of globally")
  .option("-p, --platform <platform>", "Target platform (antigravity, claude-code, codex, or all)")
  .option("-d, --dry-run", "Preview changes without modifying the filesystem")
  .option("-f, --force", "Force overwrite of existing files")
  .action((options) => {
    const code = runInit(options);
    process.exit(code);
  });

program
  .command("doctor")
  .description("Diagnose health and configuration integrity (Global and Local)")
  .action(() => {
    const code = runDoctor();
    process.exit(code);
  });

program
  .command("update")
  .description("Update Agent Code Review configuration to latest version")
  .option("-g, --global", "Update user global Agent configuration (Default)", true)
  .option("-l, --local", "Update current project workspace configuration")
  .option("-d, --dry-run", "Preview updates without writing to disk")
  .option("-f, --force", "Force update even if local changes exist")
  .action((options) => {
    const code = runInit({ ...options, force: options.force });
    process.exit(code);
  });

program
  .command("uninstall")
  .description("Safely remove Agent Code Review configuration and managed files")
  .option("-g, --global", "Uninstall user global configuration (Default)", true)
  .option("-l, --local", "Uninstall project workspace configuration")
  .option("-d, --dry-run", "Preview files to be deleted")
  .option("-f, --force", "Force deletion of modified files")
  .action((options) => {
    const code = runUninstall(options);
    process.exit(code);
  });

program
  .command("scope [target]")
  .description("Resolve and display Git diff scope (uncommitted, staged, commit SHA, or range)")
  .option("--json", "Output results in JSON format")
  .action((target, options) => {
    const code = runScope(target, options);
    process.exit(code);
  });

program.parse(process.argv);
