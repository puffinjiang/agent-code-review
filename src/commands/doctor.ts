import { Doctor } from "../lib/doctor.js";

export interface DoctorCommandOptions {
  homeDir?: string;
  workspaceRoot?: string;
}

export function runDoctor(options: DoctorCommandOptions = {}): number {
  console.log(`🩺 Diagnosing Agent Code Review environment...`);
  const report = Doctor.diagnose({
    homeDir: options.homeDir,
    workspaceRoot: options.workspaceRoot
  });

  console.log(`\nHome Directory: ${report.homeDir}`);
  console.log(`Current Workspace: ${report.workspaceRoot}\n`);

  for (const check of report.checks) {
    const symbol = check.status === "pass" ? "✅" : check.status === "warn" ? "⚠️" : "❌";
    console.log(`${symbol} [${check.name}]: ${check.message}`);
  }

  console.log(`\n--------------------------------------------------`);
  if (report.overallHealthy) {
    console.log(`✅ Configuration checks passed. Native agent discovery and review quality are not checked by doctor.`);
    return 0;
  } else {
    console.log(`⚠️ Some checks require attention.`);
    return 1;
  }
}
