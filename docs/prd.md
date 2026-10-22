# 项目开发任务：Agent Code Review

你是一名资深 AI Agent 系统架构师、开源项目维护者和高级软件工程师。

请在当前 Git 仓库中设计并实现一个完整、可安装、可复用、可扩展的开源项目。

项目名称：**Agent Code Review**

GitHub 仓库名：`agent-code-review`

项目定位：

> An open-source multi-agent code review framework for AI coding agents. Find real bugs, verify findings, and reduce false positives.

## 一、项目目标

开发一个基于 AI Coding Agent 原生能力的多 Agent 代码审查框架。

支持的目标平台：

1. Google Antigravity（第一优先级，必须实际完成和验证）
2. OpenAI Codex（提供经过核实的适配）
3. Claude Code（提供经过核实的适配）

借鉴 Anthropic Code Review 工程实践：

https://claude.dev/blog/solving-code-review-at-anthropic/

核心机制：

- 多 Agent 独立审查
- Git Diff 驱动
- 对抗式 Bug 发现
- 独立 Findings Verification
- 风险分级
- 误报过滤
- 统一结构化报告
- 可复现的验证过程
- 可控的执行成本

项目不是一个仅包含通用审查提示词的 Skill 集合，而是具有明确编排流程、职责边界、验证机制和可测试行为的 Code Review Framework。

## 二、架构原则

### 2.1 跨平台设计

采用：

**Shared Review Core + Platform Adapters**

共享层负责定义：

- 审查策略
- Reviewer 职责
- Findings 数据格式
- 验证标准
- 严重程度定义
- Git Diff 范围
- 审查流程
- 报告结构

平台适配层负责：

- Agent 注册方式
- Agent 调用方式
- Agent Skills 加载
- 工具权限
- 上下文隔离
- 并行执行能力

禁止假设 Antigravity、Codex、Claude Code 使用完全一致的配置格式。

对每个平台必须核实官方配置规范，不能编造不存在的 Agent 参数、工具或命令。

无法实际验证的平台必须明确标注为未经验证，不能声称已经完整支持。

### 2.2 优先使用原生能力

优先采用以下机制：

- Native Subagents
- Agent Skills
- Git CLI
- 本地文件系统
- 平台原生任务编排

V1 不引入额外的 LLM API 服务，不依赖独立的 Claude Code、Codex CLI 或 MCP Bridge。

目标是在只安装 Antigravity 的环境中，就可以完成一套多 Agent Code Review。

### 2.3 默认只读

代码审查阶段：

- 不修改业务代码。
- 不自动执行 Git Commit、Push、Reset。
- 不运行数据库迁移。
- 不访问生产环境。
- 不执行破坏性操作。
- 不读取与审查无关的敏感数据。
- 不自动上传代码到其他服务。

所有发现先报告，再由用户决定是否修复。

## 三、核心工作流

实现以下执行流程：

```text
/code-review (Antigravity / Claude Code) 或 $code-review (OpenAI Codex)
      |
      v
1. Git Scope Resolver
      |
      v
2. Risk Assessment
      |
      v
3. Independent Reviewers
      |
      +-- Correctness Reviewer
      |
      +-- Security Reviewer
      |
      +-- Concurrency Reviewer
      |
      +-- Performance Reviewer
      |
      v
4. Findings Aggregator
      |
      v
5. Independent Findings Verifier
      |
      v
6. Severity Classification
      |
      v
7. Final Review Report
```

允许根据风险选择 Reviewer，不要求所有 Agent 每次都执行。

如果平台支持实际并行调用，可以并行执行互相独立的 Reviewer。

如果不支持并行，则顺序执行，并在报告中准确记录执行方式。

不能仅通过 Prompt 声称实现了并行。

## 四、Review 模式

实现三种审查深度：

### Quick Review

适合小规模修改。

- 主要使用 Correctness Reviewer。
- 检查明显 Bug、回归和危险操作。
- 使用较低的 Agent 调用次数。
- 对高风险问题仍执行必要验证。

### Standard Review

默认模式。

- 根据修改文件和依赖关系选择 Reviewer。
- 审查正确性、安全和相关工程风险。
- 汇总并去重 Findings。
- 使用独立 Verifier 验证候选问题。

### Deep Review

用于重要业务或高风险变更。

- 多个专业 Reviewer 独立审查。
- 深入追踪调用链。
- 检查异常路径和并发行为。
- 对候选缺陷进行对抗式验证。
- 尽可能使用安全、针对性的测试验证。
- 明确报告未验证风险。

审查深度不应只由文件数量决定，还应考虑权限、支付、数据库迁移、并发、消息系统和数据丢失等风险。

## 五、Git 审查范围

至少支持：

- `uncommitted`：当前未提交修改
- `staged`：暂存区
- `commit`：指定提交
- `branch`：当前分支相对于目标分支
- `range`：指定提交范围

用户调用语法示例（注意各宿主平台的指令前缀差异：Antigravity 与 Claude Code 使用 `/`，OpenAI Codex 使用 `$`）：

```text
# Antigravity / Claude Code:
/code-review
/code-review HEAD
/code-review origin/main...HEAD
/code-review --mode deep
/code-review --mode quick

# OpenAI Codex:
$code-review
$code-review HEAD
$code-review --mode quick
```

这些是目标用户接口，不得直接假定平台原生支持命令参数解析。

必须根据实际 Agent Skills 能力实现对应的指令解析或明确记录支持限制。

特别注意：

1. `git diff HEAD` 不包含未跟踪文件。
2. 不允许静默忽略新增源代码。
3. 不允许错误选择比较基准。
4. Merge Commit 必须明确处理。
5. Git Diff 为空时应说明结果，而不是声称整个代码库没有 Bug。
6. 必须区分 Changed Files 和 Related Context。
7. 不应因为文件不在 Diff 中就忽视必要的上下游依赖。

## 六、Reviewer 设计

### Correctness Reviewer

检查：

- 业务逻辑
- 边界条件
- 状态转换
- 异常处理
- API 兼容性
- 空值及类型问题
- 软删除
- 数据一致性
- 功能回归

必须主动寻找反例，而不是只确认正常执行流程。

### Security Reviewer

检查：

- Authentication
- Authorization
- IDOR
- Multi-Tenant Isolation
- Injection
- SSRF
- 敏感信息泄露
- 文件访问安全
- 不安全的默认配置

认证成功不能直接视为授权正确。

现有代码采用同样模式，也不能作为安全性的充分证明。

### Concurrency Reviewer

检查：

- Race Conditions
- TOCTOU
- Idempotency
- Transaction Isolation
- Lost Updates
- Async Event Loop Blocking
- Celery / Queue Retries
- Duplicate Message Processing
- Distributed Locking
- Callback Ordering

特别注意：普通的状态判断并不等于原子并发保护。

### Performance Reviewer

检查：

- N+1 Queries
- Blocking I/O
- 非必要数据库查询
- 缺失索引
- 大对象内存占用
- 无边界循环
- 不合理的异步处理
- 可由本次修改引发的明显性能回退

没有基准测试或明确复杂度依据时，不要编造性能提升或退化百分比。

## 七、独立验证机制

实现 Findings Verifier。

Verifier 的职责不是重复描述 Reviewer 的结论，而是主动挑战这些结论。

对每个候选问题要求：

1. 阅读具体代码。
2. 追踪真实调用链。
3. 检查已有保护措施。
4. 构造具体触发场景。
5. 寻找反证或反例。
6. 判断影响是否成立。
7. 判断是否由本次修改引入。
8. 评价建议修复是否完整。
9. 必要时执行安全、针对性的验证。

Findings 状态：

- `CONFIRMED`
- `REJECTED`
- `NEEDS_VERIFICATION`

必须区分：

- 新引入缺陷
- 本次修改扩大暴露面的历史问题
- 无关的历史问题
- 缺少证据的潜在风险

不要将 `NEEDS_VERIFICATION` 伪装成已确认的 Bug。

不要把多个 Agent 意见一致当作独立代码证据。

## 八、Findings 数据规范

设计统一的 JSON Schema。

至少包含：

```json
{
  "id": "ACR-001",
  "title": "Duplicate analysis tasks can be queued",
  "severity": "P2",
  "status": "CONFIRMED",
  "category": "concurrency",
  "file": "path/to/file.py",
  "start_line": 120,
  "end_line": 125,
  "trigger": "Two requests execute concurrently",
  "impact": "Duplicate processing may occur",
  "evidence": [],
  "recommendation": "Introduce atomic state claiming",
  "origin": "introduced",
  "verification": {
    "method": "static-analysis",
    "tests_executed": false
  }
}
```

以上只是结构示例，不代表真实发现。

需要定义 Schema 校验、字段约束和版本号。

同一根因的多个 Findings 必须去重。

不同 Reviewer 的独立证据可以合并，但需要保留来源与验证记录。

## 九、严重程度定义

统一使用 P0–P3。

- P0：严重安全事件、大规模数据破坏或系统性不可用。
- P1：需要优先修复的严重生产问题。
- P2：明确影响正确性、可靠性或安全性的普通缺陷。
- P3：影响较小但可操作的问题。

避免因为问题属于安全类别，就自动提升严重程度。

严重程度必须结合可触发性、影响范围和业务后果。

不将普通代码风格、命名和格式建议作为 Bug 输出。

## 十、项目目录

采用基于唯一事实来源（SSOT）的清晰分层架构：

```text
agent-code-review/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
├── .gitignore
│
├── assets/                          # 唯一事实来源（SSOT Canonical Source）
│   ├── prompts/                     # 纯 Markdown 正文，无平台专有包装
│   │   ├── correctness-reviewer.md
│   │   ├── security-reviewer.md
│   │   ├── concurrency-reviewer.md
│   │   ├── performance-reviewer.md
│   │   └── findings-verifier.md
│   └── skills/
│       └── code-review.md           # 核心评审派发与验证规则
│
├── adapters/                        # 平台适配与动态渲染引擎
│   ├── index.ts                     # 适配器统一导出与工厂函数
│   ├── types.ts                     # 平台元数据契约 (PLATFORMS)、角色定义与接口
│   ├── render.ts                    # 纯正文动态注入 Frontmatter / TOML 包装
│   ├── assets-root.ts               # Fail-Fast 资产定位与正文加载
│   ├── normalize-path.ts            # 跨平台 POSIX 路径归一化
│   ├── antigravity/
│   │   └── index.ts                 # Google Antigravity 适配器实现
│   ├── claude-code/
│   │   └── index.ts                 # Claude Code 适配器实现
│   └── codex/
│       └── index.ts                 # OpenAI Codex 适配器实现 (TOML 自动发现)
│
├── src/
│   ├── cli.ts                       # CLI 入口与命令路由 (commander)
│   ├── index.ts                     # 模块导出入口
│   ├── commands/
│   │   ├── init.ts                  # init 命令实现 (Scope, 平台选择, 模板写入)
│   │   ├── doctor.ts                # doctor 诊断命令 (平台环境、清单哈希、验证状态)
│   │   ├── scope.ts                 # scope 命令 (Git Diff 变更范围解析)
│   │   └── uninstall.ts             # uninstall 命令 (幂等清理受管文件与叶子目录)
│   └── lib/
│       ├── detect-platform.ts       # 检测本地已安装的 AI Coding Agent CLI
│       ├── doctor.ts                # 诊断核心逻辑 (清单完整性、覆盖关系、验证状态)
│       ├── installer.ts             # 安装计划生成与执行引擎 (冲突检测、--force 接管)
│       ├── managed-path.ts          # 受管安全路径解析与公共宿主目录保护
│       ├── manifest.ts              # .agent-code-review.json 清单与 SHA-256 哈希管理
│       └── uninstaller.ts           # 卸载引擎 (白名单校验、无残留私有目录清理)
│
├── core/                            # 平台无关的核心逻辑（仅 CLI 实际调用者）
│   └── git/
│       └── scope.ts                 # Git 变更范围解析 (含未跟踪新增源码文件)
│
├── scripts/
│   ├── generate-agents.mjs          # 构建期自动生成本地 .agents/ 产物
│   └── verify-assets.mjs            # prepack 资产与渲染规范校验卡点
│
└── tests/
    └── helpers/
        └── findings.ts              # Finding 数据契约与 schema 校验（仅测试使用）
```

核心内容遵循唯一事实来源（SSOT）原则：Markdown 提示词正文与核心 Skill 集中定义在 `assets/` 中，各 Adapter 仅负责元数据声明并通过动态渲染引擎包装，严禁在适配器间手工复制维护多份静态正文。

**评审协议不在代码中二次实现。** 评审的聚合、验证、报告与模式选择规则由 LLM 依据 `assets/` 中的自然语言指令执行；代码侧**不得**再维护一份平行的 TypeScript 实现——那会产生两套规则、两处真相，且因不参与运行时而无从同步。相应的规则保障一律通过**直接断言 `assets/` 产物**来实现（见 `tests/template-contracts.test.ts`），使测试守护的是真正发布给用户的内容，而非同仓库的影子副本。

## 十一、CLI 开发、npm 发布与安装管理

本项目必须采用 **TypeScript + Node.js** 开发 CLI，通过 npm Registry 发布，并支持 npx 直接运行。

禁止使用 Python 作为安装器，也不要求用户预先全局安装本项目。

### 11.1 技术选型

- Runtime：Node.js 22 LTS 或更新的受支持版本
- Language：TypeScript
- CLI：commander
- Build：tsup
- Testing：Vitest
- Package Manager：npm
- Distribution：npm Registry
- License：MIT

尽量控制运行时依赖数量。

CLI 仅负责安装、检测、更新、卸载 Agent 配置；实际 Code Review 使用各 AI Coding Agent 平台的原生能力执行。

### 11.2 npm 包与命令

目标包名：

`agent-code-review`

CLI 可执行命令：

`agent-code-review`

通过 package.json 的 bin 字段配置，确保发布后可以直接通过 npx 调用。

实现：

```bash
npx agent-code-review@latest init
npx agent-code-review@latest init --platform antigravity
npx agent-code-review@latest doctor
npx agent-code-review@latest update
npx agent-code-review@latest uninstall
```

其中：

- init：初始化配置，可交互选择平台。
- doctor：检查安装状态和配置兼容性。
- update：安全更新由本项目管理的配置。
- uninstall：仅删除本项目安装并记录在清单中的文件与私有叶子目录，绝不修改用户配置文件，也绝不递归删除宿主共享配置目录（如 .claude、.codex、.gemini）。

支持 `--yes`、`--dry-run` 和 `--force`。明确区分两类目标对象的安全边界与覆盖规则：
1. **用户宿主平台配置文件**（如 `~/.codex/config.toml`、`~/.claude/settings.json` 等）：保持严格的零侵入原则，永不修改、追加或截断，`--force` 也不例外；
2. **本项目受管路径下的文件**（如各平台的 agent 与 skill 目标路径）：默认遇到未受管文件或被用户修改的文件时报告冲突并安全中止；仅当用户显式传入 `--force` 时，才视为获得显式授权进行覆盖并接管纳管。

### 11.3 跨平台安装

支持：

- macOS
- Linux
- Windows

支持以下平台适配：

- Antigravity（V1）
- Codex（后续）
- Claude Code（后续）

安装器应检测目标平台、项目目录及现有配置，并根据平台规范动态渲染生成 Agent 和 Skill 文件。在适配器经过各平台真实运行时长期实测验证前，其 `verified` 元数据必须显式声明为 `false`，并在 CLI（`doctor` 诊断输出 `⚠️ [Platform Verification Status]`）与文档（README 验证状态矩阵）中向用户如实展示，绝不虚假宣传。

### 11.4 安装安全

必须满足：

1. **用户宿主配置零侵入**：永不修改、追加或覆盖任何已存在的用户宿主配置文件（如 `~/.codex/config.toml`、`~/.claude/settings.json` 等），即便使用 `--force` 也绝不触碰。优先利用宿主平台的原生自动发现机制（如 `~/.codex/agents/*.toml`、`~/.gemini/config/agents/` 等），实现零侵入安装。
2. **受管文件冲突保护与显式授权接管**：对本项目受管路径下的 agent 和 skill 文件，默认不静默覆盖未受管或已被用户修改的文件；当且仅当用户显式指定 `--force` 时，才允许覆盖并接管纳管。
3. **卸载目录所有权保护**：不删除用户自定义文件，卸载时仅清理清单中记录的文件与本项目拥有的私有叶子目录，严格保护宿主公共目录所有权，禁止向上递归删除非工具私有的父级目录。
4. 维护安装清单及文件哈希。
5. 支持重复初始化且结果一致。
6. 支持 Dry Run。
7. 支持安全卸载。
8. 不自动修改 Git 配置。
9. 不执行远程安装脚本。
10. 不要求管理员权限。
11. 不在 npm install 生命周期中运行不必要的 postinstall 脚本。

### 11.5 npm 发布

正确配置 package.json 中的：

- name
- version
- description
- bin
- files
- engines
- repository
- license
- keywords

发布前执行：

```bash
npm run build
npm test
npm pack --dry-run
```

确保打包产物包含 CLI 和所有必需的 Agent Skills 配置文件。

优先采用 npm Provenance 和 GitHub Actions 进行发布，并遵循 npm 当前官方推荐的身份认证与发布方式。

在尚未实际发布前，不得宣称 npm 包已经可用。

### 11.6 最终用户体验

用户在现有项目目录运行：

```bash
npx agent-code-review@latest init
```

安装完成后，直接在相应 AI Coding Agent 平台中启动审查：

- **Antigravity / Claude Code**：在对话中输入 `/code-review`
- **OpenAI Codex**：在对话中输入 `$code-review`（或通过 `/skills` 选择）

整个过程不需要独立部署服务、不需要 Python，也不需要申请额外的 AI API Key。

目标是让普通开发者通过一条 npx 命令即可安装多 Agent Code Review 工作流。

## 十二、测试与质量要求

除了普通文件存在性检查，还必须测试实际机制。

至少包括：

1. Agent 配置格式验证。
2. Skill 格式验证。
3. Git Diff 范围解析。
4. 新增未跟踪文件处理。
5. Commit 与 Merge Commit 范围解析。
6. Findings Schema 校验。
7. Findings 去重。
8. 严重程度分类。
9. Verifier 状态分类。
10. 安装器覆盖保护。
11. 安装与卸载幂等性。
12. 空 Diff 场景。

提供一套故意包含 Bug 的测试样例，例如：

- 软删除数据未过滤。
- 不安全的资源级授权。
- 并发重复任务。
- SQL 注入。
- 空值处理错误。
- 异步阻塞调用。

这些样例用于测试 Reviewer 是否发现真实问题，不应简单将预期问题提前透露给 Reviewer。

记录：

- True Positives
- False Positives
- False Negatives
- Review Duration
- Agent Invocation Count

无法准确统计 Token 或费用时应如实标记，而不是给出估计值冒充实测。

## 十三、开源项目文档

项目需要高质量的英文 README，同时提供中文版。

README 应包括：

- 项目定位
- 核心特性
- 为什么需要多 Agent Review
- 支持平台及验证状态
- 快速安装
- 使用示例
- Quick / Standard / Deep 模式
- 工作原理
- 输出示例
- 与普通 AI Code Review 的区别
- 限制和安全说明
- Contributing
- License

特别强调：

本项目借鉴 Anthropic 公开分享的工程思路，但不是 Anthropic 官方项目，也不能暗示与其存在合作或官方授权关系。

不要直接复制第三方项目的受版权保护实现。

## 十四、开发执行顺序

按以下阶段推进，但不要只停留在计划：

### Phase 1：基础架构

- 检查仓库现状。
- 设计共享 Core。
- 定义 Findings Schema。
- 定义审查规则及严重程度。
- 创建基础文档。

### Phase 2：Antigravity MVP

- 实现原生 Subagents。
- 实现 Code Review Skill。
- 实现 Reviewer 编排。
- 实现独立 Verifier。
- 实现统一 Markdown 报告。

### Phase 3：安装与测试

- 完成安装器。
- 增加自动化测试。
- 使用测试仓库验证端到端流程。
- 验证只读约束和错误处理。

### Phase 4：跨平台适配

- 核实 Codex 官方规范。
- 核实 Claude Code 官方规范。
- 根据实际能力实现适配。
- 无法执行端到端测试的平台明确标记为实验性。

### Phase 5：文档完善

- 完善双语 README。
- 提供安装、卸载和使用示例。
- 说明审查能力与局限。
- 输出最终实现清单和测试结果。

## 十五、最终验收标准

项目达到以下条件才算完成 Antigravity MVP：

- 能安装到另一个 Git 项目。
- 能在 Antigravity 中识别 Code Review Skill。
- 能真正启动 Reviewer Subagent。
- 能独立启动 Findings Verifier。
- 能审查真实 Git Commit。
- 能正确处理无变更情况。
- 能输出统一、去重的审查报告。
- 能区分已确认问题和待验证风险。
- 不擅自修改被审查项目代码。
- 有经过实际执行的测试记录。

未完成的功能必须明确列入限制，而不是使用虚假的成功描述。

## 十六、开始执行

现在开始检查当前仓库并实施项目。

要求：

1. 先简要说明架构决策。
2. 直接创建必要文件和目录。
3. 实现真正可运行的 Antigravity MVP。
4. 执行能够运行的测试。
5. 修复测试发现的问题。
6. 完善 README 和安装文档。
7. 最终总结实际完成的功能、验证结果、尚未完成的部分。

不要只输出项目规划或伪代码。

优先确保核心审查流程真实可用，再考虑增加其他功能。

遵循 KISS、DRY、YAGNI 原则，避免为简单的配置项目引入不必要的服务端框架、数据库或复杂依赖。
