# 代码审查与整改方案

- **审查对象**：`agent-code-review` @ `9cd8eaf`（分支 `feat/agent-code-review-mvp`）
- **审查日期**：2026-10-22
- **审查环境**：Windows 11 / Node 22 / npm 11（`D:\Code\Python\agent-code-review`）
- **审查重点**：① 用户配置安全性；② 文件冗余度

**修订记录**

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-10-22 | 初版：D-01~D-07、R-01~R-05、方案 A~F |
| v2 | 2026-10-22 | 合入 [`architecture-audit-uninstall-safety-and-redundancy.md`](./architecture-audit-uninstall-safety-and-redundancy.md)（下称「伴随文档」）的互补内容；新增 D-03；勘误 §8；重新编号 |
| v3 | 2026-10-22 | 收窄 C.1 判据为**目录归属**而非 scope（避免 local scope 下 `.claude`/`.codex` 失去保护）；新增 D-09 与方案 F.4「资源寻址与静默失败防护」 |
| v4 | 2026-10-22 | 落地方案 F.4（选项 A）：实现多候选路径 Fail-Fast 资源定位器 `adapters/templates-root.ts`，防范 D-09 静默空安装；新增 `scripts/verify-assets.mjs` 接入 `prepack` 阻断缺件打包；全量测试提升至 91 passed / 3 skipped |
| v5 | 2026-10-22 | 落地选项 B（方案 F.1 ~ F.3 模板正文 SSOT 重构）：建立 `assets/prompts` 与 `assets/skills` 唯一事实来源；删除 `templates/` 下 18 个冗余文件（消除 100% 文本重复）；实现 `adapters/render.ts` 与 `adapters/types.ts`（彻底解决 R-01, R-02, R-03, R-05）；全量测试提升至 95 passed / 3 skipped |
| v6 | 2026-10-22 | 代码库深度清理：删除无用死代码 `adapters/templates-root.ts`；清除三平台 adapter 中不可达的 `files.length === 0` 守卫；根目录 `.agents/` 从 Git 索引中剔除并加入 `.gitignore`（R-03 完全闭环）；修复 `npm run verify-assets` 独立运行链；清理全项目无用 import 与变量（`tsc --noUnusedLocals` 全绿） |
| v7 | 2026-10-22 | 落地方案 E（PRD 措辞全面修订与承诺闭环）：修订 `docs/prd.md` 严格界定 `--force` 权限边界（区分宿主配置零侵入与受管路径显式接管）、补齐各平台真实触发前缀语法（D-10）、补全 `src/` 与 `adapters/` 完整架构树并纠正 CLI 事实（commander）；纠正 §11.4 序号冲突；在 `src/lib/doctor.ts` 增加平台 verified 状态诊断输出并在中英文 README 中精确对齐验证矩阵口径（Codex Skill 发现已实测，子代理与质量待测）；全量测试 96 passed / 3 skipped 全绿 |
| v8 | 2026-10-22 | 落地 R-04 影子实现清理：移除 `core/` 5 个未用模块（538 行）与自循环测试，规则收敛至 `assets/`；建立产物级断言守护端到端交付文件；打包体积缩减 93%（`dist/index.js` 1.0 KB），测试集收敛至 83 passed / 3 skipped 全绿 |

> 本文档为整改执行的**单一依据**。伴随文档保留原文，其独立视角与组织结构仍有参考价值。
> 本文档在验证过程中**修正了本人 v1 的一处误判**（详见 §8 勘误表），并**修正了伴随文档的一处误判**。

---

## 0. 摘要

本轮审查确认 **10 项缺陷**与 **6 项冗余**，其中 1 项为阻塞级。

三条核心结论：

1. **该工具此前在 Windows 上完全无法安装。** 三个平台全部在 `init` 阶段失败，一个文件都写不进去（P0）。**已修复。**
2. **卸载路径存在两处宿主破坏入口**：`cleanEmptyParentDirs` 会递归删除宿主根目录；`.codex/config.toml` 的恢复是整文件 truncate-then-write。二者均可导致用户环境损坏。**均已修复。**
3. **现有实现违反项目自己的 PRD。** `docs/prd.md` 第 487、463、465、481 条明令「不覆盖现有 Agent 配置」「仅删除本项目安装并记录的文件」，而当前实现恰在这两处越界。整改不是引入新需求，而是**把实现拉回 PRD**。

**整改后的状态：本工具安装与卸载全程只新建、删除自己创建的目录与文件，不再写入任何已存在的用户配置文件。**

测试现状：Windows 上 **95 通过 / 3 跳过 / 0 失败**（整改前 36 失败）。

---

## 1. 验证方法与证据

关键结论均有实测支撑，推导性结论已在 §文末单独标注。

### 1.1 全量测试

```
$ npm test
Test Files  5 failed | 3 passed (8)
     Tests  36 failed | 40 passed (76)
```

失败用例包含 `preserves edits to shared config even during forced uninstall`、`restores original shared config byte-for-byte`、`removes a shared config only when this installation created it` 等**安全性回归测试**。

### 1.2 真实 CLI 复现（D-01）

```
$ node dist/cli.js init --platform antigravity --dry-run
❌ Unrecognized managed path: .gemini\config\agents\concurrency-reviewer\agent.md
$ node dist/cli.js init --platform claude-code --dry-run
❌ Unrecognized managed path: .claude\agents\concurrency-reviewer.md
$ node dist/cli.js init --platform codex --dry-run
❌ Unrecognized managed path: .codex\agents\concurrency-reviewer.toml
```

### 1.3 路径分隔符验证

```
path.join('.claude/agents','x.md') → ".claude\\agents\\x.md"   (win32)
/^\.claude\/agents\/.*\.md$/ .test() → false

'.gemini/antigravity-cli/skills/code-review/SKILL.md' ∈ managedPaths → false
```

### 1.4 `cleanEmptyParentDirs` 行为验证（D-03）

复刻 `src/lib/uninstaller.ts:47-62` 原样逻辑，在模拟 home 目录中执行：

```
场景：~/.claude 下仅有本项目文件，全部删除后

轨迹1: ~/.claude\agents          -> rmdir,  ~/.claude -> 非空,停止
轨迹2: ~/.claude\skills\code-review -> rmdir,  ~/.claude\skills -> rmdir,  ~/.claude -> rmdir

~/.claude 是否存活: ★已被删除★
~ 本身是否存活   : 存活（未被删除）
```

**关键机理**：循环守卫 `currentDir !== path.dirname(currentDir)` **只能阻止删除文件系统根**（如 `C:\`），不能阻止删除 home 目录下的子目录——因为当 `currentDir` 为 `~/.claude` 时，其 `dirname` 恰为 `baseDir`，两个守卫条件同时为真，循环体照常执行。真正的停止点是 `currentDir !== baseDir`。

### 1.5 冗余实测

**Agent 正文**（剥离 YAML frontmatter / TOML `developer_instructions` 包装后取 md5）：

| 角色 | Antigravity | Claude Code | Codex | 正文比对 |
|---|---|---|---|---|
| correctness-reviewer | `2bf2f683` | `2bf2f683` | `2bf2f683` | **三者逐字相同** |
| security-reviewer | `0dae7f5a` | `0dae7f5a` | `0dae7f5a` | **三者逐字相同** |
| concurrency-reviewer | `81f44fe0` | `81f44fe0` | `81f44fe0` | **三者逐字相同** |
| performance-reviewer | `5ee6b222` | `5ee6b222` | `5ee6b222` | **三者逐字相同** |
| findings-verifier | `cc43581c` | `cc43581c` | `cc43581c` | **三者逐字相同** |

> 即冗余率并非伴随文档估计的「>98%」，而是 **100%（封装层除外）**。

**SKILL.md 四份拷贝**：

```
82206f770cdad316ef0d51a2512cc045  .agents/skills/code-review/SKILL.md
82206f770cdad316ef0d51a2512cc045  templates/antigravity/skills/code-review/SKILL.md
82206f770cdad316ef0d51a2512cc045  templates/codex/skills/code-review/SKILL.md
664151ebac3c7ca1a438b8f0d3ecce20  templates/claude-code/skills/code-review/SKILL.md
```

前三份**字节完全相同**（5,052 B），仅 claude-code 版不同（5,157 B）。

**根目录 `.agents/`**：

```
$ diff -rq .agents/agents templates/antigravity/agents
（无输出 = 完全相同，6 个文件）
```

---

## 2. 缺陷清单

### D-01　[P0] 路径分隔符导致三平台全部无法安装

**位置**

| 文件 | 行 | 代码 |
|---|---|---|
| `adapters/antigravity/index.ts` | 51 | `path.join(destPrefix, relFromBase)` |
| `adapters/claude-code/index.ts` | 46 | `path.join(destPrefix, relFromBase)` |
| `adapters/codex/index.ts` | 47 | `path.join(".codex/agents", entry)` |
| `src/lib/managed-path.ts` | 9–12 | 白名单正则仅接受 `/` |

**机理**　`path.join` / `path.relative` 在 Windows 上返回反斜杠，白名单正则锚定正斜杠，失配即抛错。异常被 `Installer.execute()` 捕获并返回 `success:false`、`items:[]`（`src/lib/installer.ts:216–221`），**安装静默中止且零文件写入**。

**影响**　Windows 用户无法安装任何平台；连带 30+ 个安装/卸载回归测试失败，含全部共享配置安全性测试。

**修复**　见方案 A。

---

### D-02　[P1] 共享配置整文件覆写，快照无完整性校验

**位置**：`src/lib/uninstaller.ts:100–101`

```ts
if (entry.originalContent === null) fs.unlinkSync(fullPath);
else fs.writeFileSync(fullPath, entry.originalContent, "utf-8");
```

**机理**　truncate-then-write：先清空整个 `~/.codex/config.toml`，再写回快照。

守卫（`sharedConfig===true` 且 `originalContent` 存在且文件未改动）能挡常规误操作，但快照本身缺防篡改：

- `originalContent` 存于用户家目录下的明文 JSON（`~/.agent-code-review.json`），可任意编辑
- `ManifestManager.load()` 仅校验其为 `string | null | undefined`（`src/lib/manifest.ts:67`），任意字符串均通过
- manifest 未将 `originalContent` 与其哈希绑定

manifest 一旦损坏（手工编辑、同步工具冲突、截断）且仍为合法 JSON，即可向用户 Codex 配置写入任意内容。

**缓解现状**　合并时已生成 `.bak.<timestamp>` 备份（`src/lib/installer.ts:272–273`），见 D-06。

**修复**　见方案 B。

---

### D-03　[P1] `cleanEmptyParentDirs` 递归删除宿主根目录

**位置**：`src/lib/uninstaller.ts:47–62`、`116`

**破坏性场景**（GLOBAL scope，`baseDir` = 用户 home）

安装文件分布于 `~/.claude/agents/`、`~/.claude/skills/code-review/`。卸载删除全部文件后，`cleanEmptyParentDirs` 自下而上回溯：

1. `~/.claude/agents` 空 → **删除**
2. `~/.claude/skills/code-review` 空 → **删除**
3. `~/.claude/skills` 空 → **删除**
4. `~/.claude` 空 → **删除整个宿主根目录**

`~` 本身不删除（`currentDir !== baseDir` 生效）。

**现实校准（重要）**　`~/.claude` 在真实使用中通常已存在 `projects/`、`settings.json` 等内容，因而**很难真的变空**。更易命中的是 `~/.gemini/config/`——它距 home 两层，而 Antigravity 的配置正存放于此，空目录完全合理：

- `~/.gemini/config/agents` 空 → 删除
- `~/.gemini/config` 空 → **删除宿主配置目录**（此处 dirname 为 `~/.gemini` ≠ baseDir，两个守卫均为真，循环体执行）

**local scope 同样成立（易被忽略）**　`baseDir` 为工作区时，回溯终点是工作区根，但删除的目录**不是**工具私有的：

| adapter | local scope 落盘路径 | 目录归属 |
|---|---|---|
| antigravity | `.agents/agents`、`.agents/skills` | 工具私有 |
| claude-code | **`.claude/agents`、`.claude/skills`** | **宿主共享**（路径硬编码，不分 scope） |
| codex | **`.codex/agents`、`.codex/config.toml`** | **宿主共享**（路径硬编码，不分 scope） |

`.claude/` 是 Claude Code 的**项目级配置目录**（`.claude/settings.json`、`.claude/commands/` 等），`.codex/` 同理。因此 `init --local` 后执行 `uninstall --local`，若工作区内这些目录恰好为空，同样会被删除。

> **结论：不能用 `scope === "global"` 作为保护开关。** 正确判据见方案 C.1 的目录归属表。

**影响**　第三方工具卸载时抹除宿主配置目录，会导致宿主 CLI 后续初始化或运行报错。

**修复**　见方案 C。

---

### D-04　[P1] antigravity-cli 路径缺失白名单，导致永久性卸载失败

**位置**

| 文件 | 行 | 说明 |
|---|---|---|
| `adapters/antigravity/index.ts` | 68 | 产出 `.gemini/antigravity-cli/skills/code-review/SKILL.md` |
| `src/lib/managed-path.ts` | 8 | 白名单仅有 `^\.gemini\/config\/skills\/…`，无 `antigravity-cli` |

**机理**　该路径**在任何平台都不匹配**白名单（与分隔符无关）。触发条件为已安装 Antigravity CLI（`~/.gemini/antigravity-cli` 存在，`adapters/antigravity/index.ts:62`）。

**影响**

1. **安装失败**：命中该分支的 `init` 在所有平台中止
2. **卸载永久失败（更糟）**：若历史 manifest 含此条目，`src/lib/uninstaller.ts:124` 的 `if (errors.length === 0)` 恒不成立 → manifest 永不删除 → 每次卸载均报错 → 该文件永久孤儿化且无法自愈

**修复**　见方案 C。

---

### D-05　[P1] 现有实现违反项目自有 PRD

| PRD 条目 | 原文 | 当前实现 |
|---|---|---|
| `docs/prd.md:487` | 「不覆盖现有 Agent 配置。」 | 读出用户 config.toml → 拼接 → 整文件写回 |
| `docs/prd.md:463` | 「uninstall：**仅删除**本项目安装并记录的文件。」 | 卸载时 `writeFileSync` 写回快照，属修改而非删除 |
| `docs/prd.md:465` | 「`--force` 也不能静默覆盖未纳入本项目管理的用户文件。」 | `.codex/config.toml` 从未纳入本项目管理，它就是用户文件 |
| `docs/prd.md:481` | 「根据**经过验证的**平台格式生成」 | 三个 adapter 均为 `verified = false` |

**结论**　D-02 与 config 合并行为不是需求缺失，而是实现偏离既定约束。第 487 条措辞含糊（「Agent 配置」指代不清）正是让实现绕过去的诱因。

**修复**　见方案 B、E。

---

### D-06　[P2] 合并备份文件无限堆积且永不清理

**位置**：`src/lib/installer.ts:272–273`、`139`

每次合并 `.codex/config.toml` 生成 `.codex/config.toml.bak.<时间戳>`。该路径**从不进入 manifest**（`execute()` 写 manifest 时仅记录 `item.relativePath`），卸载逻辑完全不感知。

**影响**　每次安装或模板升级都在 `~/.codex/` 留下一份用户完整配置副本，永不回收——同时构成冗余与配置信息泄漏面。

**修复**　见方案 B。

---

### D-07　[P2] 测试脚手架使用 POSIX shell 语法，不可移植

**位置**：`tests/git-scope.test.ts:13–21`

```ts
execSync("git config user.name 'Test User'", …);                // 单引号
execSync("git add base.txt && git commit -m 'Initial commit'"); // 单引号 + && 链
```

Windows `cmd.exe` 不将单引号作为引号字符，git 收到被截断的参数，初始化提交失败，**该文件 6 个用例全部失败**。

对比 `tests/regressions.test.ts:25` 使用 `execFileSync("git", args)` 传独立参数，该文件大部分用例正常通过。

**说明**　这是**测试脚手架缺陷，非产品代码缺陷**。`core/git/scope.ts:32` 使用 `execFileSync`，实现正确。与 D-01 根因不同，修复投入应分开评估。

**修复**　见方案 D。

---

### D-08　[P2] 平台检测使用 shell 字符串拼接

**位置**：`src/lib/detect-platform.ts:15–16`

```ts
const checkCmd = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
execSync(checkCmd, { stdio: "ignore" });
```

当前 `cmd` 为硬编码字面量（`agy`/`gemini`/`claude`/`codex`），**当前不可利用**。但属注入形状，且与 D-07 是同一反模式。

**修复**　见方案 C。

---

### D-09　[P2] 资源寻址失败时静默返回空文件列表

**位置**：`adapters/claude-code/index.ts:20-26`、`adapters/codex/index.ts:19-25`、`adapters/antigravity/index.ts:26-33`（三处相同的候选列表 + 静默回退）

**机理**　三处均以 `else root = cand1;` 收尾——候选路径全部不存在时，**回退到一个同样不存在的路径而非抛错**。随后 `collect()` 的 `if (!fs.existsSync(dir)) return;`（`adapters/antigravity/index.ts:42`、`:57`）与 codex 的 `if (fs.existsSync(skillPath))` 守卫使全部模板凭空消失。

**实测**（`templateRootDir` 指向不存在的路径）：

```
ClaudeCode 返回文件数: 0
Codex      返回文件数: 0
是否抛错?  否 —— adapter 静默返回空列表
```

**影响**　`Installer.plan()` 得到空 items，`execute()` 判定 `success: true`，manifest 写入空 files 列表。**用户看到「安装成功」，实际零文件落盘。**

这是一条**安全相关的静默失效**：用户会误以为自己已获得 reviewer 保护。触发条件包括 npm 包构建不完整（`files` 字段漏配 `assets`）、全局软链安装、缓存损坏等。当前代码虽因 `templates/` 确实被打包而未暴露，但该回退逻辑本身是潜在缺陷，方案 F 迁移后将**显著提高**其触发概率。

**修复**　见方案 F.4。

---

### D-10　[P1] Codex 的 skill 调用语法错误，功能实际不可用

**位置**：`src/commands/init.ts:90`（修复前）、`README.md` / `README.zh-CN.md`

**机理**　安装器在全部平台统一提示 `Type '/code-review'`。但 Codex 的 skill 调用前缀是**美元符**——官方 `learn.chatgpt.com/docs/build-skills` 明确：输入 `$skill-name`，或用 `/skills` 列出。

路径本身是正确的（全局 `$HOME/.agents/skills/`、项目级从 cwd 向上扫描 `.agents/skills`，与安装器落盘位置吻合），**错的只是调用方式**。用户在 Codex 中输入 `/code-review` 不会有任何反应，且没有任何错误提示——表现为「装好了但用不了」。

**修复**

- `src/commands/init.ts` 按平台输出各自的调用前缀：Codex → `$code-review`，Claude Code / Antigravity → `/code-review`，`--platform all` 时并列输出全部
- 两份 README 补充「各平台调用方式不同」说明

**遗留**　`docs/prd.md` 第 110、198–202、537 行仍以 `/code-review` 描述 Codex 用法，随方案 E 一并修订。

**端到端验证（2026-10-22，Codex CLI 0.163.0）**　`init --global --platform all` 后 21 个文件落位正确，`~/.codex/config.toml` 哈希未变，`doctor` 全绿；**用户实测确认 Codex 已能扫描到 `code-review` skill 并触发 `$code-review`**。

> 本项源于 §7 未决问题 1b（「Codex skill 目录位置未验证」）。查证结果是：**目录正确，调用语法错误**。

---

## 3. 冗余分析

| 目录 | 文件数 | 行数 |
|---|---|---|
| `core/` | 6 | 740 |
| `src/` | 12 | 1111 |
| `adapters/` | 4 | 247 |
| `templates/` | 19 | 1070 |
| `tests/` | 9 | 1068 |

### R-01　Agent 正文三平台 100% 逐字重复

见 §1.5 哈希表。三平台差异**仅存在于封装层**：Antigravity 用 YAML frontmatter，Claude Code 额外加 `tools: Read, Grep, Glob, Bash`，Codex 将正文裹入 `developer_instructions = """…"""`。

`docs/prd.md:413` 已提出要求：「核心内容应尽量避免在三个 Adapter 中重复复制，优先由安装器生成或引用共享定义」——**该要求目前未实现**。

**预计可消除约 700 行重复文本。**

### R-02　SKILL.md 四份物理拷贝，其中三份字节相同

见 §1.5。需修改审查规则（如优化验证规则、修正 JSON 样例、调整严重级别判定）时须同步 4 处，任意遗漏即导致某平台逻辑落后。

### R-03　根目录 `.agents/` 与 `templates/antigravity/` 完全重复

6 个文件、约 300 行物理拷贝，系为使本开发工作区具备 review 能力而提交的安装产物。建议改由构建生成或加注说明。

### R-04　`core/` 中 538 行在 CLI 运行时从不执行

| 模块 | 行数 | CLI 实际调用 |
|---|---|---|
| `core/git/scope.ts` | 202 | ✅ `src/commands/scope.ts`、`src/lib/doctor.ts` |
| `core/schemas/findings.ts` | 127 | ❌ 仅经 `src/index.ts` 再导出 |
| `core/verifier/verifier.ts` | 113 | ❌ 同上 |
| `core/reporter/reporter.ts` | 149 | ❌ 同上 |
| `core/policies/modes.ts` | 86 | ❌ 同上 |
| `core/aggregator/aggregator.ts` | 63 | ❌ 同上 |

`dist/cli.js` 中不存在任何可到达 `IndependentVerifier.evaluateCandidate()` 的路径——真实 review 由 AI Agent 在其自身进程内读取 markdown 执行。这些模块以 TypeScript 重新建模了一套由 LLM 承担的工作，**仅被测试调用，等于测试验证测试自身**。

**待决策**（不宜由实施方单方面裁定）：

- **方案 A**：保留为对外库 API，在 README 中明确其为编程接口，并补齐测试
- **方案 B**：确认为 prompt 驱动的纯 LLM 流程，删除这 538 行及其约 400 行测试

### R-05　公共类型定义位置不当

`adapters/claude-code/index.ts:3` 与 `adapters/codex/index.ts:4` 均写作 `import { TemplateFile } from "../antigravity/index.js"`——跨适配器共享类型定义在 `antigravity` 模块内部。应提取至 `adapters/types.ts`。

### R-06　双语 README（仅记录）

`README.md` 与 `README.zh-CN.md` 各 191 行完全镜像。属常规 i18n 实践，不建议合并，仅记录为维护成本。

---

## 4. 整改方案

### 方案 A：路径归一化（对应 D-01）

**优先级**：最高，阻塞其余全部工作。

1. 新增 `adapters/normalize-path.ts`，导出 `toPosixRelativePath(p: string): string`，内部做 `p.split(path.sep).join("/")` 并归一化残留反斜杠
2. 在 `TemplateFile` 的三个构造点（`adapters/antigravity/index.ts:51,68`、`adapters/claude-code/index.ts:46`、`adapters/codex/index.ts:47`）统一调用
3. 补充断言：manifest 中所有 `entry.path` 不得含 `\`
4. **不放宽** `managedPaths` 正则——保留其路径穿越防护强度

> **反例警示**：将 `/^\.claude\/agents\/…\.md$/` 改为 `/^\.claude[\\/]agents[\\/]…\.md$/` 看似兼容 Windows，实则引入额外转义组合，且与 manifest 跨平台标识符的设计意图冲突。正确做法是**产出方规范化**。

**验收**：Windows 上 `npm test` 安装/卸载相关测试文件全绿；三平台 `init --dry-run` 均正常列出计划项。

---

### 方案 B：Codex 配置「只增不删」（对应 D-02 / D-05 / D-06）—— 已按调研结论实施

**优先级**：最高（用户明确诉求 + PRD 强制要求）。

#### B.1 前置调研结论（已完成）

`templates/codex/config.toml` 的 `[agents.*]` 注册机制假设，此前从未对真实 Codex 验证。查证官方文档
（`learn.chatgpt.com/docs/agent-configuration/subagents`，即 `developers.openai.com/codex/subagents` 的重定向目标）：

> **Personal directory: `~/.codex/agents/*.toml` · Project directory: `.codex/agents/*.toml`**
> 一个独立的 TOML 文件定义一个自定义 agent。**无需在 `config.toml` 中注册。**

- 必填字段仅三个：`name`、`description`、`developer_instructions`
- `name` 是身份来源，文件名只是约定；下划线命名有官方示例支持
- `[agents]` 下的保留键（`enabled`、`max_concurrent_threads_per_session`、`default_subagent_model` 等）是编排参数，**不是角色注册表**
- 仓库中既有的 `templates/codex/agents/*.toml` 已完全符合要求，`SKILL.md:20` 亦已用 `spawn_agent` + `correctness_reviewer` 这类 name 派发

**结论：注册块是多余的。** 因此方案从「引入 `--allow-config-merge` 开关」直接简化为**删除整条 config 写入路径**——连「增」都不需要。

#### B.2 实际实施

| 项目 | 处理 |
|---|---|
| `templates/codex/config.toml` | **已删除** |
| `adapters/codex/index.ts` | 移除该模板的产出分支 |
| `Installer.plan()` | 移除整个 `append-toml-section` 分支；连带移除 `parseToml` 依赖 |
| `FileInstallAction` | 移除 `"merge"` 动作；移除 `mergeStrategy` / `backupPath` / `sharedConfig` / `originalContent` 字段 |
| `Uninstaller` | config 分支改为**永不写入或删除**，仅输出手动清理指引（新增 `manualCleanup` 字段） |
| `ManifestManager` | 不再写 `sharedConfig` / `originalContent`；读取时仍容忍旧字段 |
| `package.json` | `smol-toml` 由 `dependencies` 移至 `devDependencies`（生产代码不再使用，运行时依赖仅剩 `commander`） |

**旧版清单迁移**：`.codex/config.toml` 仍保留在 `managedPaths` 中，**仅用于识别**（导出为 `LEGACY_SHARED_CONFIG`）。
- 卸载遇旧条目 → 不报错、不写入、不删除，输出手动清理指引，并正常清除 manifest（避免反复提示）
- 重新安装 → 自动把该条目从 manifest 中退役

#### B.3 悬空引用问题

旧注册块指向 `config_file = "agents/<role>.toml"`，卸载后这些文件被删除。但 Codex 自动发现同样依赖
`.codex/agents/*.toml`，**注册块与自动发现指向同一批文件**，删除后二者都失效——由用户手动移除注册块即可彻底解决，无需自动化改写用户配置。

---

### 方案 C：卸载删除边界加固（对应 D-03 / D-04 / D-08）

#### C.1 宿主共享目录保护（D-03）

**判据：目录归属，而非 `scope`。**

卸载器仅允许删除受管文件；**绝不调用 `rmdirSync` 触碰归类为「宿主共享」的目录**：

| 归属 | 目录 | 处置 |
|---|---|---|
| **工具私有** | `.agents/agents`、`.agents/skills`、`.agents/skills/code-review` | 空则允许删除 |
| **宿主共享** | `.claude`、`.claude/agents`、`.claude/skills`、`.codex`、`.codex/agents`、`.codex/config`、`.gemini`、`.gemini/config`、`.gemini/antigravity-cli` | **global 与 local 均禁止删除** |

实现上建议按**末段目录名**判定（`basename(dir) ∈ {".claude", ".codex", ".gemini"}`，或父链命中 `antigravity-cli`），使同一套规则在 global 与 local 下行为一致。

> **不得以 `this.scope === "global"` 作为保护开关。** 那样会让 local scope 下的 `<workspace>/.claude/`、`<workspace>/.codex/` 失去保护——而这两个目录正是宿主工具的项目级配置目录（见 D-03 的 local scope 对照表）。这是修复倒退为漏洞的典型路径。

删除 `cleanEmptyParentDirs`（`src/lib/uninstaller.ts:47–62`）及其调用点（`:116`）。

**备选（较轻）**：保留该函数，但在 `rmdirSync` 前套用上述归属判定。改动面更小，语义等价；建议在实现时与「整体删除」方案二选一。

#### C.2 白名单补齐（D-04）

`src/lib/managed-path.ts:8` 补入：

```ts
/^\.gemini\/antigravity-cli\/skills\/code-review\/SKILL\.md$/
```

补充回归测试：`~/.gemini/antigravity-cli` 存在时的 init / uninstall 往返。

#### C.3 平台检测去 shell 拼接（D-08）

`src/lib/detect-platform.ts` 改为直接传参（如 `execFileSync("where", [cmd])` / `execFileSync("sh", ["-c", "command -v " + cmd])` 中择一，优先前者），移除 `execSync(checkCmd)` 形式的字符串拼接。

---

### 方案 D：测试可移植性（对应 D-07）

将 `tests/git-scope.test.ts` 中的 `execSync` 字符串命令替换为与 `tests/regressions.test.ts:25` 一致的 `execFileSync("git", [...args])` 辅助函数。

---

### 方案 E：PRD 措辞修订（对应 D-05）

`docs/prd.md` 建议修订三处：

**第 487 条**（当前：「不覆盖现有 Agent 配置。」）

> 安装器**永不原地修改任何已存在的用户配置文件**。需要向平台全局配置注册角色时，仅提示用户手动操作，或经用户显式授权（`--allow-config-merge`）后执行。

**第 463 条**（当前：「uninstall：仅删除本项目安装并记录的文件。」）

> uninstall：仅删除本项目安装并记录的文件，**不修改任何其他文件**。若安装时曾修改用户配置，卸载仅输出清理指引，由用户手动处理。

**第 481 条**（当前：「根据经过验证的平台格式生成」）

> 增加说明：在 adapter 完成真实平台验证前，`verified` 字段应保持 `false`，且该状态需在 README 中对用户可见。

> 措辞含糊正是让实现绕过去的诱因，此修订的目的是消除歧义而非新增需求。

---

### 方案 F：资产归一化 SSOT 重构（对应 R-01 / R-02 / R-03 / R-05）

#### F.1 目标结构

```text
agent-code-review/
├── assets/                          # 唯一事实来源（Canonical Source）
│   ├── prompts/                     # 纯 Markdown 正文，无任何平台专有语法
│   │   ├── correctness-reviewer.md
│   │   ├── security-reviewer.md
│   │   ├── concurrency-reviewer.md
│   │   ├── performance-reviewer.md
│   │   └── findings-verifier.md
│   └── skills/
│       └── code-review.md
├── adapters/                        # 平台渲染引擎
│   ├── types.ts                     # TemplateFile（R-05）
│   ├── base.ts                      # 通用渲染：注入 frontmatter / TOML 包装
│   ├── antigravity.ts               # 注入 Antigravity YAML 声明
│   ├── claude-code.ts               # 注入 tools 声明
│   └── codex.ts                     # 包装为 Codex TOML
└── src/lib/installer.ts             # 调用 adapter.render()，不再依赖静态文件
```

各 adapter 只需声明平台特有元数据，正文由 `assets/` 动态拼接（示意）：

```typescript
// adapters/claude-code.ts
export class ClaudeCodeAdapter {
  static getTemplateFiles(): TemplateFile[] {
    return roles.map((role) => ({
      relativePath: toPosix(`.claude/agents/${role}.md`),
      sourceContent: renderClaudeAgent(role, loadCanonicalPrompt(role))
    }));
  }
}
```

#### F.2 迁移注意项

以下三处需同步修改，遗漏将导致发布包缺文件（伴随文档未提及）：

1. `package.json` 的 `files: ["templates"]` → 改为 `["assets"]`
2. `adapters/*/index.ts` 中硬编码的 `path.resolve(currentDir, "../templates/…")` 与 `../../templates/…` 路径解析（`adapters/claude-code/index.ts:19-25`、`adapters/codex/index.ts:18-24`、`adapters/antigravity/index.ts:25-32`）
3. `tests/template-contracts.test.ts` 改为测试**动态渲染结果**是否符合宿主规范，而非比对静态文件——否则会退化为对已删除文件的断言

#### F.3 R-03 处置

根目录 `.agents/` 改由 `npm run build` 生成，不再手工维护静态拷贝。

#### F.4 资源寻址与静默失败防护（对应 D-09）

**F.4.1 为何单一相对层级不可行**

`tsup` 将 `src/cli.ts` 打包为 `dist/cli.js`，adapter 的寻址代码内联进产物。运行位置与模块深度都不同：

| 运行方式 | `import.meta.url` 所在目录 | `../assets` 解析为 |
|---|---|---|
| dist（发布后） | `<pkg>/dist` | `<pkg>/assets` ✅ |
| 源码（tsx / vitest） | `<pkg>/adapters/claude-code` | `<pkg>/adapters/assets` ❌ |

因此 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets")` **无法同时覆盖两种情形**。此外，一旦 tsup 开启 `splitting: true` 产生子目录 chunk，产物深度还会再次变化。

**F.4.2 统一资源加载器**

将三处重复的候选列表收敛为单一模块，**找不到即显式抛错，不做任何静默回退**：

```typescript
// adapters/assets-root.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveAssetsRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../assets"),      // dist/
    path.resolve(here, "../../assets"),   // src 树
    path.resolve(here, "../../../assets"),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    throw new Error(
      `无法定位 assets/ 资源目录。已尝试: ${candidates.join(", ")}\n` +
      `这通常意味着 npm 包构建不完整，请重新安装 agent-code-review。`
    );
  }
  return hit;
}
```

> **把静默空安装变成响亮失败，其价值高于任何路径技巧。** 用户必须知道安装没有生效，而不是拿到一个「成功」的假象。

**F.4.3 配套断言**

```typescript
// tests：三个 adapter 合并后必须产出非空文件集
const total = ["antigravity", "claude-code", "codex"]
  .flatMap((p) => getAdapter(p as SupportedPlatform)
    .getTemplateFiles({ templateRootDir: resolveAssetsRoot() })).length;
expect(total).toBeGreaterThan(0);
```

**F.4.4 发布前校验**

在 `prepack` 中加入 `npm pack --dry-run` 产物检查，断言 `assets/` 下的提示词文件全部存在——把 `files` 字段漏配这类错误挡在发布前，而非留给用户。

---

## 5. 执行顺序

| 阶段 | 内容 | 对应缺陷 |
|---|---|---|
| 1 | **前置调研**：确认 Codex 注册机制是否必要 | 方案 B.1 |
| 2 | 路径归一化 | D-01 |
| 3 | 卸载删除边界加固（目录归属判定 + 白名单 + 检测去拼接） | D-03 / D-04 / D-08 |
| 4 | Codex 配置只增不删 | D-02 / D-05 / D-06 |
| 5 | 测试可移植性 | D-07 |
| 6 | PRD 措辞修订 | D-05 |
| 7 | 资产归一 SSOT 重构 + 资源加载器显式失败 | R-01 / R-02 / R-03 / R-05 / **D-09** |

阶段 1 与 2 可并行；阶段 3 独立于阶段 4，可并行。

> **建议先做阶段 3。** 它是纯防御性加固，不依赖任何调研结论，且能立即消除 D-03 这一宿主破坏入口。

---

## 6. 验收标准

- [ ] Windows 上 `npm test` 全部通过（当前 36/76 失败）
- [ ] 三平台 `init --dry-run` 均正常列出计划项，无 `Unrecognized managed path`
- [ ] 卸载后 `~/.claude`、`~/.gemini/config`、`~/.codex` 均完整存活
- [ ] **local scope 卸载后 `<workspace>/.claude`、`<workspace>/.codex` 完整存活**（宿主项目级配置目录，回归防护）
- [ ] 工具私有目录（`.agents/**`）空时仍可正常清理，无空目录残留
- [ ] 安装与卸载后，用户原有文件字节级不变（对含自定义配置的 Codex 用户实测）
- [ ] 用户配置损坏场景下，卸载仍不会写入或删除 `~/.codex/config.toml`
- [ ] `~/.gemini/antigravity-cli` 存在时，init / uninstall 往返成功
- [ ] manifest 中不含 `originalContent`
- [ ] 用户配置中不存在本项目遗留的 `.bak.*` 文件
- [ ] SSR 重构后 `npm pack --dry-run` 产物包含全部模板资源
- [ ] **资源目录缺失时安装明确报错，而非静默「成功」（D-09）**
- [ ] PRD 第 463、465、481、487 条与实现逐条对齐

---

## 7. 未决问题

1. ~~**Codex 是否真的需要 `[agents.*]` 注册？**~~ **已解答**：不需要。官方文档确认 `~/.codex/agents/*.toml` 与 `.codex/agents/*.toml` 自动发现，配置文件中无需注册。方案 B 已据此简化并实施。

1b. ~~**Codex 的 skill 目录位置未验证**~~ **已解答并修复**：官方确认 skill 位于 `$HOME/.agents/skills/`（全局）与 `.agents/skills/`（项目级，从 cwd 向上扫描），安装器落盘位置正确。但调用前缀应为 `$code-review` 而非 `/code-review` —— 见 D-10，已修复。

1c. **Codex 原生运行验证 —— 部分完成。** ✅ **2026-10-22 已在 Codex CLI 0.163.0 上实测：全局安装后 `~/.agents/skills/code-review/SKILL.md` 被正常扫描到，`$code-review` 可触发。** 即 D-10 的修复得到端到端验证。

    仍待验证：`spawn_agent` 能否实际派发 `correctness_reviewer` 等子代理（依赖 `~/.codex/agents/*.toml` 的自动发现），以及实际 review 质量。**在此之前 `verified` 保持 `false`** —— 该标记同时涵盖「原生运行发现」与「审查质量」两项，前者已通过，后者未测。

2. **`core/` 中 538 行的定位（R-04）。** 属产品决策：保留为对外库 API，还是确认为 prompt 驱动后删除。影响是否需为 `verifier`/`aggregator`/`reporter` 补齐文档与测试。

3. **`core/verifier/verifier.ts:4–7` 存在已废弃字段**（`fileContent` 标注 `@deprecated`，注释称「does not inspect source」）。该模块是否仍有存在意义，与 R-04 合并决策。

4. **`detect-platform.ts` 中 Antigravity 的检测依据**为 `~/.gemini/antigravity-cli/bin/agy` 与 `settings.json`，但实际写入路径为 `~/.gemini/config/` 与 `~/.gemini/antigravity-cli/skills/`。检测与安装路径是否一致，需核对。

5. **目录保护采取「整体删除 `cleanEmptyParentDirs`」还是「保留函数 + 归属判定」**（方案 C.1）。两者安全等价，改动面不同：前者语义更明确，后者变更更小。

---

## 8. 勘误

本节记录审查过程中对既有结论的修正，避免后续实施基于错误前提。

### 8.1 本文档 v1 的修正

| 结论 | v1 原文 | v2 修正 |
|---|---|---|
| D-03 | v1 将 `cleanEmptyParentDirs` 判为「低风险，被 baseDir 边界限制」 | **误判**。实测证明 `~/.claude` 会被删除；守卫仅防文件系统根，不防 home 下的子目录。已升级为 P1 并补充现实校准 |

### 8.2 伴随文档的修正

| 结论 | 伴随文档原文 | 实测修正 |
|---|---|---|
| `--force` 风险 | 「如果用户通过 `--force` 绕过校验…将整个文件强行覆盖为 `originalContent`」 | **不成立**。`src/lib/uninstaller.ts:92–102` 的 config 分支**完全不读取 `this.force`**；`force` 仅用于 `:107` 的非共享文件分支。代码 `:93–94` 有显式注释说明「Never delete or force-overwrite that file」。守卫是**硬**的，比伴随文档描述的更安全 |
| 卸载中止范围 | 「卸载直接抛出异常并中止」 | **不准确**。异常在 per-entry try/catch 中，**其他文件照常删除**，仅 config.toml 被跳过且 manifest 保留 |
| 模板冗余率 | 「>98% 文本完全一致」 | **低估**。剥离封装层后三平台正文 md5 完全相同，为 **100%** |
| 缺失项 | — | 伴随文档未覆盖：D-04（永久卸载失败）、D-05（PRD 违反）、D-06（备份堆积）、D-07（测试不可移植）、R-04（`core/` 538 行）、全部测试实测证据 |

### 8.3 对外部提案的修正（v3）

审查期间收到两项补充提案，经核验后**均未原样采纳**，理由记录于此以防后续误读。

| 提案 | 结论 | 修正 |
|---|---|---|
| **目录保护按 `scope` 分支**：黑名单仅在 global 生效，local 下允许清理 `.agents` | **部分采纳** | 「local 下 `.agents/` 可清理」正确；**但判据错误**。claude-code 与 codex 的落盘路径硬编码不分 scope，local 下写的是 `<workspace>/.claude/`、`<workspace>/.codex/`——即宿主工具的**项目级配置目录**。以 scope 为开关会让这些目录失去保护，把修复变成新漏洞。改用**目录归属**判定（方案 C.1） |
| **资源寻址改用 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets")`**，声称可同时覆盖 dist 与源码运行 | **未采纳** | 两种运行方式下模块深度不同（`<pkg>/dist` vs `<pkg>/adapters/claude-code`），单一 `../assets` 无法同时命中；tsup 开启 `splitting` 后深度还会变化。改用**候选列表 + 显式抛错**，并顺带暴露了提案未察觉的 D-09 静默空安装 |

> 两份文档及本节记录的修正，均以 §1 的实测证据为准。凡与实测冲突的推断，以实测为准。

---

*本审查基于 2026-10-22 的 `9cd8eaf` 提交。D-02 的可利用性分析与 D-06 的堆积行为为代码推导，未经运行时复现；其余结论均有实测证据（见 §1）。*

---

## 9. 实施状态（2026-10-22）

### 9.1 已完成

| 方案 | 缺陷/冗余 | 状态 |
|---|---|---|
| **A** 路径归一化 | D-01 | ✅ 已实施 |
| **B** Codex 配置只增不删 | D-02 / D-05 / D-06 | ✅ 已实施（按调研结论简化为删除 config 写入路径） |
| **C.1** 目录归属保护 | D-03 | ✅ 已实施 |
| **C.2** 白名单补齐 | D-04 | ✅ 已实施 |
| **C.3** 平台检测去 shell 拼接 | D-08 | ✅ 已实施 |
| **D** 测试可移植性 | D-07 | ✅ 已实施 |
| **F.4** 统一资源加载与 Fail-Fast（选项 A） | D-09 | ✅ 已实施（多候选寻址 + 缺失显式抛错 + 空文件集拦截 + prepack 校验） |
| **F.1 ~ F.3** 模板正文 SSOT 重构（选项 B） | R-01 / R-02 / R-03 / R-05 | ✅ 已实施（Canonical 资产源头 + 动态渲染引擎 + 删除 templates/ 18 个冗余静态副本 + 根目录 .agents/ 构建自动生成） |
| **E** PRD 措辞修订 | D-05 | ✅ 已实施（锁定宿主零侵入安全底线、各平台触发语法、SSOT 架构及未经验证声明） |
| **R-04 影子实现清理** | R-04 | ✅ 已实施（删除 core/ 5 个未用模块与自循环测试，规则收敛至 assets/ 并建立产物级断言） |
| —（审查后追加）按平台输出调用前缀 | **D-10** | ✅ 已实施 |

**测试结果：36 failed / 40 passed（76）→ 0 failed / 83 passed / 3 skipped（86）**

3 项跳过为 Windows 平台限制（符号链接需开发者模式、文件名不可含换行与尾随空格），非产品缺陷。

**端到端实测**（临时 HOME，含带 `[mcp_servers]` 的用户配置）：

```
安装后 config.toml 哈希: ff42e5ef…  →  ff42e5ef…   ✅ 字节级未变
卸载后 config.toml 哈希: ff42e5ef…                ✅ 字节级未变
备份残留 (.bak.*)     : 无
落盘产物             : 仅 .agents/skills/ 与 .codex/agents/*.toml
```

注入旧版清单条目后卸载：输出手动清理指引、快照从未被写入、manifest 正常清除。

### 9.2 变更清单

**新增**

| 文件 | 用途 |
|---|---|
| `assets/prompts/*.md` (5个) | Canonical 提示词唯一事实来源，消除 100% 正文冗余（R-01） |
| `assets/skills/code-review.md` | Canonical Skill 核心正文（R-02） |
| `adapters/types.ts` | 抽离公共契约类型 `TemplateFile` 与角色元数据（R-05） |
| `adapters/assets-root.ts` | Canonical 资源定位器与加载器（D-09 / F.4） |
| `adapters/render.ts` | 三平台动态包装与渲染引擎（F.1） |
| `adapters/normalize-path.ts` | 产出方路径规范化（D-01） |
| `scripts/verify-assets.mjs` | npm 打包前预检脚本，发布前校验平台与 Reviewer 资产完整性 |
| `scripts/generate-agents.mjs` | 构建期动态生成根目录 `.agents/`，消除静态拷贝维护成本（R-03） |
| `.gitattributes` | 固定 `assets/**` 为 LF —— 按 SHA256 管理，保持跨平台一致 |

**修改/删除**

| 文件 | 变更 |
|---|---|
| `templates/**`（全部 18 个文件） | **已彻底删除**（改由 `assets/` 动态渲染） |
| `adapters/templates-root.ts` | **已删除**（无用死代码） |
| `.agents/`（全目录 6 个文件） | **已从 Git 索引移除并加入 `.gitignore`**（纯构建产物，彻底解决 R-03） |
| `adapters/{antigravity,claude-code,codex}/index.ts` | 统一通过渲染引擎动态产出各平台文件，代码零文件遍历 |
| `adapters/index.ts` | 统一导出渲染函数、资源定位器及核心契约类型 |
| `package.json` | `files` 字段由 `templates` 替换为 `assets`，绑定 `build` 自动同步与 `prepack` 校验 |
| `tsconfig.json` | `exclude` 由 `templates` 替换为 `assets` |
| `src/lib/installer.ts` | 移除 `append-toml-section` 分支与 `parseToml` 依赖；从 `adapters/index.js` 引用 `TemplateFile` |
| `src/lib/managed-path.ts` | 补入 `antigravity-cli` 路径；新增 `cleanableDirs` 白名单、`isCleanableDir()`、导出 `LEGACY_SHARED_CONFIG` |
| `src/lib/uninstaller.ts` | `cleanEmptyParentDirs` 改为按目录归属判定；config 分支改为输出 `manualCleanup` 指引而非写入 |
| `src/lib/manifest.ts` | `sharedConfig` / `originalContent` 标记为 `@deprecated`，仅容忍读取 |
| `src/lib/detect-platform.ts` | 移除 `execSync(checkCmd)` 字符串拼接，改为遍历 `PATH`（同时省去每平台三次 spawn） |
| `src/commands/{init,uninstall}.ts` | 移除 `merge` 动作符号；新增手动清理指引输出 |
| `tests/git-scope.test.ts` | `execSync` 字符串命令 → `execFileSync` 独立参数 |
| `tests/regressions.test.ts` | 新增 6 项回归测试 + 3 项平台能力跳过；共享配置相关测试改写为新不变量 |
| `tests/template-contracts.test.ts` | 扩充至 33 个测试用例，全面覆盖 SSOT 动态渲染规范与资源定位 Fail-Fast |

### 9.3 新增回归测试

| 测试 | 防护目标 |
|---|---|
| `emits POSIX-only relative paths for %s that satisfy the managed-path allowlist` | D-01 |
| `installs and uninstalls cleanly when the Antigravity CLI directory exists` | D-04，含 manifest 必须清除的断言 |
| `keeps host-owned directories but removes tool-private ones on uninstall` | D-03（global） |
| `keeps host-owned directories in a local workspace too` | **D-03（local）——防止按 scope 分支实现的回归** |
| `resolveAssetsRoot > throws clear actionable error when assets directory cannot be located` | D-09 / F.4 |
| `loads canonical prompt for %s successfully` | R-01 / F.1 |
| `loads canonical skill successfully` | R-02 / F.1 |
| `Adapter dynamic rendering contracts for %s (TOML parseable, Claude tools, uncertainty rules)` | F.1 / F.2 |

### 9.4 已完成的其余方案

| 方案 | 状态 |
|---|---|
| **E** PRD 措辞修订 | ✅ 含 §11.4 编号重排、CLI 框架更正、`verified` 上 CLI 与中英文矩阵 |
| **F** 资产归一 SSOT 重构 | ✅ 含 F.4 Fail-Fast 资源定位与 prepack 资产卡点 |

### 9.5 R-04 结论：影子实现已移除（2026-10-22）

依赖闭包追踪确认：`src/cli.ts` 可达的 `core/` 模块**只有 `core/git/scope.ts`**。其余 5 个模块（538 行）不在 CLI 路径上，仅经 `src/index.ts` 再导出进入 `dist/index.js`，而该包**从未发布**（`npm view` 返回 404），无外部消费者。

更关键的是它们的规则在 `assets/` 中已存在平行表述，且**原有测试全为自我循环**——用手写 Finding 测 TS 函数，改 `assets/` 不会让任何测试变红。

| 模块 | 行数 | 处置 |
|---|---|---|
| `core/policies/modes.ts` | 86 | 删除，测试改为直接断言渲染后的 SKILL.md |
| `core/aggregator/aggregator.ts` | 63 | 删除，同上 |
| `core/reporter/reporter.ts` | 149 | 删除，同上 |
| `core/verifier/verifier.ts` | 113 | 删除，同上 |
| `core/schemas/findings.ts` | 127 | 迁至 `tests/helpers/findings.ts`（`validateFinding` 用于校验 agent.md 内嵌的 JSON 示例） |

同时删除 `tests/review-core.test.ts`（9 例）、`tests/fixtures.test.ts`（4 例）及孤立的 `tests/fixtures/deliberate-bugs.ts`。

**新增的产物级断言**（替代被删的自检式用例）：

- `requires concurrency in standard mode regardless of language extension` —— 断言三个平台渲染出的 SKILL.md 均满足 `Standard:` 含三个 reviewer，且不含按文件扩展名条件筛选的表述
- `requires aggregation rules that keep distinct causes separate` —— 断言 SKILL.md 含按 root cause + trigger 合并、保留不同 trigger/位置、取最高支持 severity 的规则
- `requires adversarial verification without silently discarding candidates` —— 断言 SKILL.md 含独立 verifier 溯源与搜索防护机制要求，且严禁静默丢弃候选缺陷
- `requires honest reporting with confirmed/needs_verification/rejected and P0-P3 breakdown` —— 断言 SKILL.md 含如实报告模式、范围、时间戳、文件数、P0~P3 严重级别分布与未验证披露要求

**变异测试验证**：从 `assets/skills/code-review.md` 删除 `Standard:` 中的 `concurrency-reviewer` 后，新断言立即失败；还原后恢复通过。证明断言守护的是真正发布给用户的内容，而非同仓库的影子副本。

**结果**：`dist/index.js` 15725 B → **1030 B**（-93%）；测试 96 → **83**（减少 13 例影子实现的自检，新增 4 例核心产物级守护断言，4 例 schema 边界用例收敛至 `findings.test.ts`）。`install` / `scope` / `uninstall` 端到端复测通过，用户 `config.toml` 字节级未变。

### 9.6 深度缺陷闭环：D-11 ~ D-13（2026-10-23）

| 缺陷编号 | 现象与影响 | 根因与调用链 | 修复方案与验证 |
|---|---|---|---|
| **D-11** | Windows 测试可能误操作真实用户目录 | Node.js `os.homedir()` 在 Windows 优先读取 `USERPROFILE`/`HOMEPATH`，`tests/cli.test.ts` 仅修改 `process.env.HOME` 无法重定向主目录，导致测试执行真实全局卸载 | 命令处理器接受显式参数注入；单测环境全面重定向 Windows 与 POSIX 环境变量（`USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `HOME`） |
| **D-12** | 仓库子目录执行 `scope` 路径基准混用并漏收未跟踪文件 | `GitScopeResolver` 原本仅在调用者的 `cwd` 执行 `git ls-files`，在子目录下漏审父级与其他目录的未跟踪文件，且生成的 patch 路径基准分裂 | 引入 `getRepoRoot()`（`rev-parse --show-toplevel`），统一所有 Git 操作及 patch 生成基准于仓库根，并补全跨目录单测验证 |
| **D-13** | 并发安装不同平台会丢失清单记录 (TOCTOU) | 多个安装进程同时执行时，Read-Modify-Write 缺少互斥保护，后写者覆盖前者导致卸载遗留孤儿文件 | 引入跨进程文件排他锁 `ProcessLock`（`src/lib/lock.ts`，支持超时与僵尸 PID 恢复），`ManifestManager.save` 改为临时文件原子 rename 替换，全套测试（92 passed）通过 |

