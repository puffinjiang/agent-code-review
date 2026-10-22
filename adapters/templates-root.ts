import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 定位随包分发的模板根目录。
 *
 * tsup 把 adapter 内联进产物，运行位置与源码树不同，单一相对层级无法同时覆盖：
 *
 * | 运行方式      | import.meta.url 所在目录   | ../templates |
 * |---------------|-----------------------------|--------------|
 * | dist（发布后）| <pkg>/dist                   | ✅            |
 * | 源码（tsx）   | <pkg>/adapters/claude-code   | ❌           |
 *
 * 打包器开启 code splitting 后产物深度还可能变化，故用候选列表兜底。
 *
 * 关键约束：**找不到就抛错，绝不回退到某个同样不存在的路径。** 静默回退会让
 * adapter 返回空文件列表，安装“成功”却零文件落盘 —— 用户会误以为自己已获得
 * reviewer 保护。响亮失败优于假成功。
 *
 * 注：方案 F.1 将 `templates/` 重命名为 `assets/` 时，只需改动此处常量。
 */
export function resolveTemplatesRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../templates"), // dist/
    path.resolve(here, "../../templates"), // src 树
    path.resolve(here, "../../../templates")
  ];

  const hit = candidates.find((candidate) => fs.existsSync(candidate));
  if (!hit) {
    throw new Error(
      `无法定位模板目录 templates/。已尝试以下路径：\n` +
        candidates.map((c) => `  - ${c}`).join("\n") +
        `\n\n这通常意味着 npm 包构建不完整，或安装过程被中断。\n` +
        `请重新安装 agent-code-review：npm i -g agent-code-review`
    );
  }
  return hit;
}

/**
 * 解析指定平台的模板目录。
 *
 * 平台目录缺失同样属于构建/分发故障，必须显式失败：否则 adapter 会安静地返回
 * 空列表，让安装“成功”却什么也没装。
 *
 * 当显式提供 explicitRoot 时，支持两种布局：
 * 1. 传入的是总模板目录（包含 <platform> 子目录） -> 自动进入子目录；
 * 2. 传入的直接是平台专属目录（本身包含 agents/ 或 skills/） -> 直接使用。
 */
export function resolvePlatformTemplates(platform: string, explicitRoot?: string): string {
  if (explicitRoot) {
    const direct = path.resolve(explicitRoot);
    const sub = path.join(direct, platform);
    if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
      return sub;
    }
    if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
      return direct;
    }
    throw new Error(`模板目录缺失：${direct}\n该平台的模板资源不完整，请重新安装 agent-code-review。`);
  }

  const dir = path.join(resolveTemplatesRoot(), platform);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`模板目录缺失：${dir}\n该平台的模板资源不完整，请重新安装 agent-code-review。`);
  }
  return dir;
}