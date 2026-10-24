import * as fs from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  shims: true,
  define: {
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
