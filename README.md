# Agent Code Review (ACR)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](tsconfig.json)
[![Architecture: Global First](https://img.shields.io/badge/Architecture-Global%20First-success.svg)](#-global-first-installation)

> **An open-source multi-agent code review framework for AI coding agents. Specialized review prompts, explicit independent verification, and installation utilities.**

[中文文档 (Chinese)](./README.zh-CN.md)

---

## 💡 Overview

A review can mistake missing local checks for bugs already prevented by callers, middleware, or database constraints. This project asks a separate verifier to search for that counter-evidence. Its effect on false-positive rates has not been measured.

**Agent Code Review** introduces an adversarial, multi-agent review architecture inspired by [Anthropic's engineering practices on code review](https://claude.dev/blog/solving-code-review-at-anthropic/). Specialized reviewer agents inspect the diff independently, aggregate findings by root cause, and pass candidate issues to an **Independent Findings Verifier** that actively challenges each finding before reporting it.

---

## 🌍 Global First Installation

Agent Code Review follows a **Global First** design philosophy. By default, running `init` installs the Reviewer Subagents and Skills directly into your user-level Agent configuration directory. **Install once, and run code reviews across every Git repository on your machine** without duplicating configurations or npm dependencies in every project.

```bash
# Recommended: Install globally across all detected platforms (Antigravity, Claude Code, Codex)
npx agent-code-review@latest init

# Explicit global installation for a specific platform
npx agent-code-review@latest init --global --platform antigravity
npx agent-code-review@latest init --global --platform claude-code
npx agent-code-review@latest init --global --platform codex
npx agent-code-review@latest init --global --platform all

# Optional: Install only for the current project repository
npx agent-code-review@latest init --local

# Preview planned changes without modifying any files
npx agent-code-review@latest init --dry-run

# Run diagnostic health check on global & local configurations
npx agent-code-review@latest doctor

# Safely uninstall (removes only managed, unedited files)
npx agent-code-review@latest uninstall
npx agent-code-review@latest uninstall --local
```

### Installation Target Paths

| Platform | Global Scope (`--global`, Default) | Local Scope (`--local`) |
| :--- | :--- | :--- |
| **Google Antigravity** | `~/.gemini/config/skills/code-review/SKILL.md`<br>`~/.gemini/config/agents/<reviewer>/agent.md` | `.agents/skills/code-review/SKILL.md`<br>`.agents/agents/<reviewer>/agent.md` |
| **Claude Code** | `~/.claude/skills/code-review/SKILL.md`<br>`~/.claude/agents/<reviewer>.md` | `.claude/skills/code-review/SKILL.md`<br>`.claude/agents/<reviewer>.md` |
| **OpenAI Codex** | `~/.agents/skills/code-review/SKILL.md`<br>`~/.codex/agents/<reviewer>.toml` | `.agents/skills/code-review/SKILL.md`<br>`.codex/agents/<reviewer>.toml` |

### Safety Guarantees
- **No Elevated Privileges**: Uses standard user permissions (`os.homedir()`), never requires `sudo`.
- **Manifest Tracking**: Maintains `.agent-code-review.json` recording paths, platforms, and SHA-256 hashes.
- **Never Writes Existing User Config**: Installation only creates directories and files it owns. It never adds to, rewrites, or deletes an existing configuration file — not even with `--force`. Codex discovers reviewer agents from `~/.codex/agents/*.toml` automatically, so no entry in `config.toml` is required. Uninstall removes only what was installed; if an older version ever appended a block to your Codex config, uninstall prints manual removal instructions instead of editing the file.
- **Conflict Prevention**: Refuses to overwrite unmanaged or user-edited managed files without explicit `--force`. Conflicting shared configuration is always preserved. Managed paths cannot traverse directories or follow symlinks.
- **Precedence Awareness**: `doctor` automatically warns if a local workspace configuration overrides your global settings.

---

## Runtime Boundaries & Platform Verification Status

The CLI installs templates, diagnoses file integrity, and resolves Git scopes. The host agent executes the review skill and native delegation; the package does not automatically invoke an LLM. The exported TypeScript aggregator, verifier helper, and reporter are optional data utilities and are not automatically called by the installed skill. `IndependentVerifier` records explicit external evaluation facts; it does not inspect code or prove findings itself. If independent delegation is unavailable, the skill must disclose that limitation.

### Platform Verification Matrix

| Platform | Format & Templates | Verification Status (`verified`) | Command Trigger |
| :--- | :--- | :--- | :--- |
| **Google Antigravity** | Implemented (`~/.gemini/config/...`) | ⚠️ **Unverified (`false`)** (Templates & unit tests ready; runtime quality unvalidated) | `/code-review` |
| **Claude Code** | Implemented (`~/.claude/...`) | ⚠️ **Unverified (`false`)** (YAML metadata aligned; native delegation unvalidated) | `/code-review` |
| **OpenAI Codex** | Implemented (`~/.codex/agents/*.toml` auto-discovery) | ⚠️ **Unverified (`false`)** (TOML format aligned; auto-discovery unvalidated) | `$code-review` |

> [!IMPORTANT]
> The `verified` flag for all platforms is strictly set to `false` and transparently reported by `npx agent-code-review doctor`. Flags will only be set to `true` after thorough, recorded testing and review quality validation on actual native host runtimes.

## 🏛️ Architecture & Workflow

```text
/code-review [scope]
       │
       ▼
 1. Git Scope Resolver (uncommitted, staged, commit, branch range, untracked source files)
       │
       ▼
 2. Risk Assessment (Quick / Standard / Deep mode selection)
       │
       ▼
 3. Independent Specialized Reviewers
       ├── Correctness Reviewer (logic, edge cases, state machines, soft-deletes)
       ├── Security Reviewer (authz/authn, IDOR, SQLi, SSRF, injection)
       ├── Concurrency Reviewer (race conditions, TOCTOU, idempotency, lost updates)
       └── Performance Reviewer (N+1 queries, unindexed filters, blocking I/O)
       │
       ▼
 4. Findings Aggregator (root-cause clustering, evidence merging, severity elevation)
       │
       ▼
 5. Independent Findings Verifier (Adversarial challenge, code-path trace, counter-evidence)
       │
       ▼
 6. Severity Classification (P0–P3 based on real blast radius)
       │
       ▼
 7. Final Structured Report (Confirmed vs Needs-Verification vs Rejected False Positives)
```

---

## 💻 Usage

Once installed globally, trigger a multi-agent review inside **any** project directly from your Agent session:

```bash
# Review current working tree (includes uncommitted tracked and untracked source files)
/code-review

# Review staged changes
/code-review staged

# Review a specific commit
/code-review HEAD~1

# Review a feature branch against main
/code-review origin/main...HEAD

# Fast review for small patches
/code-review --mode quick

# Thorough audit for high-risk changes
/code-review --mode deep
```

---

## 🔍 Review Modes

- **Quick Review**: Activates the `correctness-reviewer` for functional sanity checks and fast turnaround on small diffs.
- **Standard Review (Default)**: Dispatches `correctness-reviewer`, `security-reviewer`, and `concurrency-reviewer`, aggregates results, and runs independent adversarial verification.
- **Deep Review**: Activates all reviewers (including `performance-reviewer`), conducts deep call-chain tracing, and challenges all edge cases.

---

## 🛡️ Severity Definitions

- **P0**: Critical security breach (e.g. arbitrary SQL injection, remote code execution) or catastrophic data destruction.
- **P1**: High-priority defect (e.g. IDOR cross-tenant data access, race condition causing duplicate financial transactions, soft-delete bypass).
- **P2**: Normal functional bug or correctness issue impacting production reliability.
- **P3**: Minor operable defect or localized inefficiency.

*Cosmetic linting, formatting, and naming preferences are strictly filtered out and never reported as bugs.*

---

## 🔒 Default Read-Only Guarantee

The review framework operates in a **strictly read-only mode** during review:
- Does NOT alter your business code.
- Does NOT execute `git commit`, `git push`, or `git reset`.
- Does NOT run database migrations or mutate application state.
- All findings are reported back to you, leaving all remediation decisions in your control.

---

## 🧪 Testing & Verification

```bash
npm test
npm run build
npm pack --dry-run
```

Test coverage includes:
1. Global First installation lifecycle & homedir path handling.
2. Safe merge of shared configuration files with backups.
3. Git Scope Resolver (uncommitted, staged, commit SHAs, ranges, merge commits, untracked source files, and empty diff handling).
4. Findings Aggregator deduplication and multi-evidence merging.
5. External-evaluator decision helper (`CONFIRMED`, `REJECTED`, `NEEDS_VERIFICATION`).
6. Regression cases for command injection, symlink/traversal handling, configuration preservation, conservative verification, and distinct findings.

The deliberate bug fixtures and handwritten finding tests do **not** measure LLM detection accuracy. Native agent discovery, end-to-end delegation, recall, and false-positive rates have not been validated on the three platforms. See [the evaluation protocol](docs/reviewer-evaluation.md).

---

## ⚖️ Attribution & Disclaimer

This project is an independent open-source initiative inspired by engineering practices publicly shared by [Anthropic](https://claude.dev/blog/solving-code-review-at-anthropic/). It is not affiliated with, endorsed by, or sponsored by Anthropic, Google, or OpenAI.

---

## 📄 License

[MIT License](LICENSE) © 2026 Puffin
