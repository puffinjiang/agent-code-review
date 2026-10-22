#!/usr/bin/env node
/**
 * 根目录 .agents/ 动态同步生成脚本（消除 R-03 冗余）。
 *
 * 通过 AntigravityAdapter 的 local scope 动态生成工作区专属的 .agents/ 目录，
 * 保持工作区 AI Agent 能力与 assets/ 唯一事实来源严格同步，不再手工维护静态拷贝。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AntigravityAdapter } from "../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = AntigravityAdapter.getTemplateFiles({ isGlobal: false });

for (const file of files) {
  const targetPath = path.join(root, file.relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, file.sourceContent, "utf-8");
}

console.log(`✅ 已从 assets/ 自动生成根目录 .agents/（共 ${files.length} 个文件）`);
