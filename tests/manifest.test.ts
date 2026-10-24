import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InstallationManifest, ManifestManager } from "../src/lib/manifest.js";

describe("ManifestManager Unit Tests", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acr-manifest-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should compute accurate SHA-256 content hashes", () => {
    const hash = ManifestManager.computeHash("hello world");
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("should save and load valid installation manifest", () => {
    const manifest: InstallationManifest = {
      schemaVersion: "1.0.0",
      packageVersion: "0.1.0",
      scope: "global",
      platforms: ["antigravity"],
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files: [
        {
          path: ".gemini/config/skills/code-review/SKILL.md",
          hash: ManifestManager.computeHash("content"),
          platform: "antigravity",
          installedAt: new Date().toISOString(),
        },
      ],
    };

    ManifestManager.save(tempDir, manifest);
    const loaded = ManifestManager.load(tempDir);
    expect(loaded).toEqual(manifest);

    const removed = ManifestManager.remove(tempDir);
    expect(removed).toBe(true);
    expect(ManifestManager.load(tempDir)).toBeNull();
  });

  it("should reject corrupted or invalid manifests gracefully", () => {
    const manifestPath = ManifestManager.getManifestPath(tempDir);

    // 1. Invalid JSON
    fs.writeFileSync(manifestPath, "invalid-json{", "utf-8");
    expect(ManifestManager.load(tempDir)).toBeNull();

    // 2. Missing required schema version
    fs.writeFileSync(manifestPath, JSON.stringify({ packageVersion: "0.1.0" }), "utf-8");
    expect(ManifestManager.load(tempDir)).toBeNull();

    // 3. Invalid file hash format
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "1.0.0",
        packageVersion: "0.1.0",
        scope: "global",
        platforms: ["antigravity"],
        files: [{ path: "file.md", hash: "not-a-sha256", platform: "antigravity" }],
      }),
      "utf-8",
    );
    expect(ManifestManager.load(tempDir)).toBeNull();
  });

  it("should allow rapid same-millisecond ManifestManager.save calls without temp file collision (D-14)", () => {
    for (let i = 0; i < 10; i++) {
      ManifestManager.save(tempDir, {
        schemaVersion: "1.0.0",
        packageVersion: "0.1.0",
        scope: "global",
        platforms: ["antigravity"],
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        files: [],
      });
    }
    expect(ManifestManager.load(tempDir)?.platforms).toEqual(["antigravity"]);
  });
});
