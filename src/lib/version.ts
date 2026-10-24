import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

export function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;

  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    let dir = currentDir;
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        if (pkg && typeof pkg.version === "string") {
          cachedVersion = pkg.version;
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fallback
  }

  cachedVersion = "unknown";
  return cachedVersion;
}
