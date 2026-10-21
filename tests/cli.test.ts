import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { runInit } from "../src/commands/init.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runUninstall } from "../src/commands/uninstall.js";
import { runScope } from "../src/commands/scope.js";

describe("CLI Commands Integration", () => {
  let tempDir: string;
  let tempHome: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acr-cli-test-"));
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "acr-cli-home-"));
    process.env.HOME = tempHome;
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome) process.env.HOME = originalHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("should run global init and doctor successfully by default", () => {
    const initCode = runInit({ platform: "antigravity" });
    expect(initCode).toBe(0);

    const doctorCode = runDoctor();
    expect(doctorCode).toBe(0);

    const uninstallCode = runUninstall({ global: true });
    expect(uninstallCode).toBe(0);
  });

  it("should run local init and uninstall when --local is provided", () => {
    const initCode = runInit({ local: true, platform: "antigravity" });
    expect(initCode).toBe(0);

    const uninstallCode = runUninstall({ local: true });
    expect(uninstallCode).toBe(0);
  });

  it("should run scope command in git repository", () => {
    fs.writeFileSync(path.join(tempDir, "sample.txt"), "hello world");
    const scopeCode = runScope("uncommitted", { json: true });
    expect(scopeCode).toBe(0);
  });
});
