# Agent Code Review (ACR) - 多 Agent 代码审查框架

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](tsconfig.json)
[![Architecture: Global First](https://img.shields.io/badge/Architecture-Global%20First-success.svg)](#-全局优先global-first安装)

> **专为 AI Coding Agent 设计的开源多 Agent 代码审查框架。提供专业审查提示词、独立验证流程和安装工具。**

[English Documentation](./README.md)

---

## 💡 为什么需要 Agent Code Review？

单次审查可能遗漏调用链中的防护，或将惯用代码模式误判为缺陷。本项目要求独立 verifier 寻找反证；目前尚未测量误报率改善幅度。重点关注：
1. **大量虚假误报（False Positives）**：模型往往将架构外层（如中间件、网关或装饰器）已经兜底拦截的场景误判为高危缺陷。
2. **无关细节噪音（Nitpicking）**：倾向于挑剔变量命名、缩进风格或无实质风险的代码写法，却遗漏深层次的并发竞态（Race Condition）和越权（IDOR）隐患。

**Agent Code Review** 借鉴了 [Anthropic 官方代码审查工程实践](https://claude.dev/blog/solving-code-review-at-anthropic/) 的核心理念，构建了多 Agent 分工协同与对抗式验证架构：由多位独立专业 Reviewer 审查 Git Diff，聚合候选缺陷，并交由 **独立的 Findings Verifier（对抗式反向验证者）** 深入代码调用链寻找反证，只有经受住反向挑战的问题才会被确认为真正缺陷。

---

## 🌍 全局优先（Global First）安装

Agent Code Review 采用 **Global First（全局优先）** 的现代化安装架构。用户只需执行一次安装，配置即写入当前用户的全局 Agent 目录，**机器上的任意项目均可直接调用 Code Review 工作流，绝不要求每个 Git 仓库重复配置或安装 npm 依赖**。

```bash
# 推荐：全局安装（自动识别已安装平台：Antigravity、Claude Code、Codex）
npx agent-code-review@latest init

# 显式指定平台进行全局安装
npx agent-code-review@latest init --global --platform antigravity
npx agent-code-review@latest init --global --platform claude-code
npx agent-code-review@latest init --global --platform codex
npx agent-code-review@latest init --global --platform all

# 可选：仅为当前项目安装（项目级隔离）
npx agent-code-review@latest init --local

# 预览安装计划（Dry Run，不改动任何文件）
npx agent-code-review@latest init --dry-run

# 环境诊断检查（同时扫描全局与本地配置）
npx agent-code-review@latest doctor

# 将已安装配置更新至最新模板版本
npx agent-code-review@latest update

# 查看解析后的 Git Diff 范围（支持未提交、staged、指定 Commit 或分支范围）
npx agent-code-review@latest scope
npx agent-code-review@latest scope staged --json

# 安全卸载（仅安全清理未被用户修改的管理文件）
npx agent-code-review@latest uninstall
npx agent-code-review@latest uninstall --local
```

### 各平台安装路径规范

| 平台 | 全局安装路径（`--global`，默认） | 项目级安装路径（`--local`） |
| :--- | :--- | :--- |
| **Google Antigravity** | `~/.gemini/config/skills/code-review/SKILL.md`<br>`~/.gemini/config/agents/<reviewer>/agent.md` | `.agents/skills/code-review/SKILL.md`<br>`.agents/agents/<reviewer>/agent.md` |
| **Claude Code** | `~/.claude/skills/code-review/SKILL.md`<br>`~/.claude/agents/<reviewer>.md` | `.claude/skills/code-review/SKILL.md`<br>`.claude/agents/<reviewer>.md` |
| **OpenAI Codex** | `~/.agents/skills/code-review/SKILL.md`<br>`~/.codex/agents/<reviewer>.toml` | `.agents/skills/code-review/SKILL.md`<br>`.codex/agents/<reviewer>.toml` |

### 安装安全保障
- **用户权限安全**：使用 Node.js `os.homedir()`，绝不要求 `sudo` 提权。
- **清单与哈希管理**：维护 `.agent-code-review.json` 清单，精准记录受管文件路径与 SHA-256 哈希。
- **绝不写入已有用户配置**：安装只创建自身拥有的目录与文件，绝不新增、改写或删除任何已存在的配置文件，即使使用 `--force`。Codex 会自动发现 `~/.codex/agents/*.toml` 中的 reviewer，因此无需在 `config.toml` 中注册。卸载仅移除本次安装的内容；若旧版本曾向 Codex 配置追加过内容，卸载只会打印手动清理指引，不会修改该文件。
- **保护用户资产**：重装或更新不会默认覆盖用户修改；受管路径禁止目录穿越和符号链接。普通文件只有显式 `--force` 才允许覆盖用户编辑。
- **优先级告警**：`doctor` 会自动检测本地项目配置是否遮蔽了全局配置并给出清晰提醒。

---

## 实际运行边界与平台验证状态

CLI 负责安装模板、检查文件完整性和解析 Git 范围；审查由宿主 Agent 执行 skill 和原生子代理调度。本包不会自动调用 LLM。评审协议本身（聚合、验证与报告规则）完全定义在 `assets/` 的提示词资产中并由宿主 Agent 执行，本包不再提供这些规则的 TypeScript 平行实现；相应的规则保障通过直接断言 `assets/` 产物来实现。

### 平台验证状态矩阵

| 平台 | 模板与配置格式 | 平台验证状态 | 审查启动指令 |
| :--- | :--- | :--- | :--- |
| **Google Antigravity** | 已实现（`~/.gemini/config/...`） | ✅ **已验证**（原生 Agent 发现、子代理派发与多 Agent 审查流程已实测） | `/code-review` |
| **Claude Code** | 已实现（`~/.claude/...`） | ✅ **已验证**（原生 Slash Command、子代理提示词派发与审查流程已实测） | `/code-review` |
| **OpenAI Codex** | 已实现（`~/.codex/agents/*.toml` 自动发现） | ✅ **已验证**（Skill 自动发现 `$code-review`、Agent 配置与审查流程已实测） | `$code-review` |

> [!NOTE]
> 以上所有支持平台均已在原生宿主运行环境中完成实际联调与功能验证。您可随时执行 `npx agent-code-review doctor` 诊断安装状态、目录完整性及 Git 仓库配置。

## 🏛️ 核心架构与工作流

```text
/code-review [范围]
       │
       ▼
 1. Git Scope Resolver（解析未提交、暂存区、指定 Commit、分支范围，主动纳入新增未跟踪文件）
       │
       ▼
 2. 风险评估与模式选择（Quick / Standard / Deep 模式）
       │
       ▼
 3. 独立专业 Reviewer
       ├── Correctness Reviewer（业务逻辑、边界条件、状态转换、异常传播、跨平台语义等）
       ├── Security Reviewer（认证鉴权、IDOR、信任边界、SQL/命令/选项注入、软链与文件风险、SSRF 等）
       ├── Concurrency Reviewer（竞态条件、TOCTOU、文件锁与同步缺陷、幂等性、非原子状态变更等）
       └── Performance Reviewer（N+1 查询、缺失索引、阻塞 I/O、循环派生子进程、无界遍历等）
       │
       ▼
 4. Findings Aggregator（按根因聚类、合并多角度证据、提炼最高严重度）
       │
       ▼
 5. Independent Findings Verifier（独立对抗验证：追踪真实代码链、寻找现有防护反证、剔除误报）
       │
       ▼
 6. 严重程度分级（基于真实爆炸半径评定 P0–P3）
       │
       ▼
 7. 最终结构化报告（明确区分已确认缺陷、待验证风险、已过滤误报）
```

---

## 💻 使用方法

全局安装完成后，在**任何** Git 项目中打开你的 Agent 会话即可执行：

```bash
# 审查当前工作区变更（自动包含未暂存修改与新增源码文件）
/code-review

# 审查暂存区变更
/code-review staged

# 审查指定提交
/code-review HEAD~1

# 审查特性分支相对于主分支的变更
/code-review origin/main...HEAD

# 快速审查（适合小改动或临时修复）
/code-review --mode quick

# 深度审查（高风险业务、全量 Reviewer 介入）
/code-review --mode deep
```

---

## 🔍 审查模式说明

- **Quick Review（快速模式）**：调度 `correctness-reviewer`，对明显回归、空值或接口破损进行快速扫描。
- **Standard Review（标准模式，默认）**：调度 `correctness-reviewer`、`security-reviewer` 与 `concurrency-reviewer`，汇总并去重缺陷，交由 Verifier 深度核验。
- **Deep Review（深度模式）**：全量调度包括 `performance-reviewer` 在内的所有专业审查员，要求追踪调用链并执行独立对抗验证。

---

## 🛡️ 严重级别定义

- **P0**：灾难性安全漏洞（如无鉴权的任意 SQL 注入、远程命令执行）或系统性数据破坏。
- **P1**：高危生产故障（如 IDOR 跨租户越权查询、高并发任务重复领取与双花、软删除数据泄露）。
- **P2**：直接影响业务正确性或可用性的普通功能缺陷。
- **P3**：轻微缺陷或局部可优化问题。

*纯代码格式、缩进或个人偏好风格严格不在 Bug 报告中呈现。*

---

## 🔒 默认只读安全原则

审查过程遵循严格的**只读约束**：
- 绝对不擅自修改被审查项目的业务代码。
- 绝对不执行 `git commit`、`git push` 或 `git reset`。
- 绝对不执行数据库迁移或环境变更。
- 所有发现以清晰结构化报告形式呈现，由开发者拥有最终修复决策权。

---

## 🧪 测试与质量保证

```bash
npm test
npm run build
npm pack --dry-run
```

包含测试覆盖：
1. Global First 与项目级安装/卸载生命周期、跨平台路径与主目录隔离。
2. 跨平台路径归一化，以及宿主目录（`.claude` / `.codex` / `.gemini`）的删除保护与工具私有目录清理。
3. 跨进程文件锁（`ProcessLock`）互斥、防符号链接跟随与清单（Manifest）原子持久化。
4. Git Diff 范围解析（未提交变更、暂存区、提交范围、附注标签、Merge Commit、子目录执行、未跟踪新增文件与空 Diff 场景）。
5. SSOT 提示词与 Skill 动态渲染、三平台 Frontmatter 结构校验与 Finding JSON 协议契约测试。
6. Git 参数/命令注入、符号链接、路径穿越、用户配置保护、对抗验证与聚合规则契约的回归测试。

单元与契约测试验证安装器安全性、Git 范围解析、跨进程文件锁与提示词/Schema 契约。Google Antigravity、Claude Code 与 OpenAI Codex 三个平台的原生 Agent 发现、子代理派发与多 Agent 审查流程均已在真实开发环境中完成实测。

---

## ⚖️ 声誉与版权声明

本项目系独立开源项目，设计思路借鉴了 [Anthropic 公开发表的代码审查工程博客](https://claude.dev/blog/solving-code-review-at-anthropic/)。本项目与 Anthropic、Google 或 OpenAI 无官方隶属、合作或商业授权关系。

---

## 📄 开源许可证

[MIT License](LICENSE) © 2026 Puffin
