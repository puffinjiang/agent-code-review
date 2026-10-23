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
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      HOMEDRIVE: process.env.HOMEDRIVE,
      HOMEPATH: process.env.HOMEPATH
    };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acr-cli-test-"));
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "acr-cli-home-"));

    // Secure all OS environment variables for homedir resolution (POSIX + Windows)
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("should run global init and doctor successfully by default via os.homedir()", () => {
    expect(os.homedir()).toBe(tempHome);

    const initCode = runInit({ platform: "antigravity" });
    expect(initCode).toBe(0);
    expect(fs.existsSync(path.join(tempHome, ".agent-code-review.json"))).toBe(true);

    const doctorCode = runDoctor();
    expect(doctorCode).toBe(0);

    const uninstallCode = runUninstall({ global: true });
    expect(uninstallCode).toBe(0);
    expect(fs.existsSync(path.join(tempHome, ".agent-code-review.json"))).toBe(false);
  });

  it("should run local init and uninstall when --local is provided", () => {
    const initCode = runInit({ local: true, platform: "antigravity" });
    expect(initCode).toBe(0);
    expect(fs.existsSync(path.join(tempDir, ".agent-code-review.json"))).toBe(true);

    const uninstallCode = runUninstall({ local: true });
    expect(uninstallCode).toBe(0);
    expect(fs.existsSync(path.join(tempDir, ".agent-code-review.json"))).toBe(false);
  });

  it("should run scope command in git repository", () => {
    fs.writeFileSync(path.join(tempDir, "sample.txt"), "hello world");
    const scopeCode = runScope("uncommitted", { json: true });
    expect(scopeCode).toBe(0);
  });
});
