import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCanonicalSkill } from "../adapters/assets-root.js";
import { GitScopeResolver } from "../core/git/scope.js";

// Execute the documented example against controlled helpers in a disposable repo.
// No shell evaluates the prompt text; Git alone invokes the fixture helper.
describe("Documented and CLI Git query safeguards", () => {
  let directory: string;
  let marker: string;
  let environment: NodeJS.ProcessEnv;

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      env: environment,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "acr-prompt-git-"));
    marker = path.join(directory, "helper-executed");
    // Git expects a config file path; Node's Windows null-device path is not portable here.
    const globalConfig = path.join(directory, "empty.gitconfig");
    fs.writeFileSync(globalConfig, "");
    environment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig };
    for (const key of Object.keys(environment)) {
      if (
        [
          "GIT_DIR",
          "GIT_WORK_TREE",
          "GIT_INDEX_FILE",
          "GIT_COMMON_DIR",
          "GIT_EXTERNAL_DIFF",
          "GIT_CONFIG_PARAMETERS",
        ].includes(key) ||
        key === "GIT_CONFIG_COUNT" ||
        key.startsWith("GIT_CONFIG_KEY_") ||
        key.startsWith("GIT_CONFIG_VALUE_")
      )
        delete environment[key];
    }
    // The resolver inherits the test process environment, so isolate it using
    // the same environment as the fixture Git invocations.
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    for (const key of Object.keys(process.env)) {
      if (!(key in environment)) vi.stubEnv(key, undefined);
    }
    git("init");
    git("config", "user.name", "Prompt test");
    git("config", "user.email", "prompt@example.com");
    git("config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(directory, "tracked.txt"), "before\n");
    fs.writeFileSync(path.join(directory, ".gitattributes"), "tracked.txt diff=fixture\n");
    git("add", "tracked.txt", ".gitattributes");
    git("commit", "-m", "fixture baseline");
    fs.writeFileSync(path.join(directory, "tracked.txt"), "after\n");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  type Helper = "external diff" | "textconv" | "fsmonitor";
  const configureHelper = (mechanism: Helper) => {
    const helper = path.join(directory, "helper.cjs");
    fs.writeFileSync(
      helper,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n` +
        // Protocol v2: a token followed by '/' requests a full working-tree scan.
        (mechanism === "fsmonitor" ? "process.stdout.write('fixture-token\\0/\\0');\n" : ""),
    );
    // Git's helper configuration is a shell command, so quote paths for that shell.
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const helperCommand = `${quote(process.execPath)} ${quote(helper)}`;
    const configKey = {
      "external diff": "diff.external",
      textconv: "diff.fixture.textconv",
      fsmonitor: "core.fsmonitor",
    }[mechanism];
    git("config", configKey, helperCommand);
    if (mechanism === "fsmonitor") git("config", "core.fsmonitorHookVersion", "2");
    return helperCommand;
  };

  it.each(["external diff", "textconv"] as const)(
    "disables a configured %s helper",
    (mechanism) => {
      configureHelper(mechanism);

      git("diff");
      expect(fs.existsSync(marker)).toBe(true);
      fs.unlinkSync(marker);

      const example = loadCanonicalSkill().match(/^- `(git [^`]+ diff [^`]+)`$/m)?.[1];
      if (!example) throw new Error("Missing documented safe diff command");
      expect(example.endsWith("<validated arguments>")).toBe(true);
      const args = example.slice(4).replace("<validated arguments>", "HEAD --").split(" ");
      const patch = git(...args);
      expect(fs.existsSync(marker)).toBe(false);
      expect(patch).toContain("-before");
      expect(patch).toContain("+after");
    },
  );

  it("disables a configured fsmonitor helper for the documented status query", () => {
    const helperCommand = configureHelper("fsmonitor");

    git("status", "--porcelain");
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);

    const example = loadCanonicalSkill().match(/^- `(git [^`]+ status --porcelain)`$/m)?.[1];
    if (!example) throw new Error("Missing documented safe status command");
    const status = git(...example.slice(4).split(" "));
    expect(fs.existsSync(marker)).toBe(false);
    expect(status).toContain(" M tracked.txt");
    expect(git("config", "--get", "core.fsmonitor").trim()).toBe(helperCommand);
  });

  const scopes = [
    "uncommitted",
    "working-tree",
    "staged",
    "commit",
    "range",
    "merge",
    "tag",
  ] as const;
  it.each(scopes)("keeps raw patches and suppresses diff helpers for CLI %s scope", (scope) => {
    let target: string = scope;
    const historical = ["commit", "range", "merge", "tag"].includes(scope);
    if (scope === "merge") git("checkout", "-b", "feature");
    if (scope === "staged" || historical) git("add", "tracked.txt");
    if (historical) git("commit", "-m", "update tracked file");
    if (scope === "merge") {
      git("checkout", "-");
      git("merge", "--no-ff", "feature", "-m", "merge feature");
    }
    if (scope === "commit" || scope === "merge") target = "HEAD";
    if (scope === "range") target = "HEAD~1..HEAD";
    if (scope === "tag") {
      git("tag", "-a", "test-tag", "-m", "fixture tag");
      target = "test-tag";
    }

    for (const mechanism of ["external diff", "textconv"] as const) {
      configureHelper(mechanism);
      git("diff", ...(historical ? ["HEAD^1", "HEAD"] : ["HEAD"]), "--");
      expect(fs.existsSync(marker)).toBe(true);
      fs.unlinkSync(marker);

      const result = new GitScopeResolver(directory).resolve({ target, includeUntracked: false });
      expect(fs.existsSync(marker)).toBe(false);
      expect(result.changedFiles).toEqual(["tracked.txt"]);
      expect(result.patch).toContain("-before");
      expect(result.patch).toContain("+after");
      if (mechanism === "external diff") git("config", "--unset-all", "diff.external");
    }
  });

  it("suppresses fsmonitor during CLI scope collection without changing configuration", () => {
    const helperCommand = configureHelper("fsmonitor");
    git("status", "--porcelain");
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);

    const result = new GitScopeResolver(directory).resolve({ includeUntracked: false });
    expect(fs.existsSync(marker)).toBe(false);
    expect(result.changedFiles).toEqual(["tracked.txt"]);
    expect(result.patch).toContain("+after");
    expect(git("config", "--get", "core.fsmonitor").trim()).toBe(helperCommand);
  });

  it("suppresses an inherited external diff helper during CLI scope collection", () => {
    const helperCommand = configureHelper("external diff");
    git("config", "--unset-all", "diff.external");
    environment.GIT_EXTERNAL_DIFF = helperCommand;
    vi.stubEnv("GIT_EXTERNAL_DIFF", helperCommand);
    git("diff", "HEAD", "--");
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);

    const result = new GitScopeResolver(directory).resolve({ includeUntracked: false });
    expect(fs.existsSync(marker)).toBe(false);
    expect(result.patch).toContain("+after");
  });
});
