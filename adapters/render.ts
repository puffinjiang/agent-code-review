import { REVIEWER_METADATA, type ReviewerRole, SKILL_METADATA } from "./types.js";

/**
 * 平台渲染引擎：将 Canonical Markdown 正文与各平台专有元数据/包装层动态拼接。
 * 实现 100% 字节兼容，消除三平台在 Agent 正文与 Skill 正文上的物理重复（R-01 / R-02）。
 */

function escapeTomlMultilineBasicString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\b", "\\b")
    .replaceAll("\f", "\\f")
    .replaceAll("\r", "\\r")
    .replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, (ch) => {
      return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    })
    .replace(/"{3,}|"$/g, (quotes) => '\\"'.repeat(quotes.length));
}

function formatYamlFoldedValue(value: string): string {
  return value.replace(/\r?\n+/g, " ");
}

function formatYamlScalarValue(value: string): string {
  if (/[\r\n:#"'[\]{}&*!|>%@`\\]|^\s|\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

export function renderAntigravityAgent(role: ReviewerRole, body: string): string {
  const meta = REVIEWER_METADATA[role];
  return `---\nname: ${role}\ndescription: >-\n  ${formatYamlFoldedValue(meta.description)}\n---\n\n${body}`;
}

export function renderAntigravitySkill(body: string): string {
  return `---\nname: ${SKILL_METADATA.name}\ndescription: ${formatYamlScalarValue(SKILL_METADATA.description)}\n---\n\n${body}`;
}

export function renderClaudeAgent(role: ReviewerRole, body: string): string {
  const meta = REVIEWER_METADATA[role];
  return `---\nname: ${role}\ndescription: >-\n  ${formatYamlFoldedValue(meta.description)}\ntools: Read, Grep, Glob, Bash\n---\n\n${body}`;
}

export function renderClaudeSkill(body: string): string {
  const claudeBody = body.replace(
    "# Independent code review\n\n",
    "# Independent code review\n\nArguments: $ARGUMENTS\n\n",
  );
  return `---\nname: ${SKILL_METADATA.name}\ndescription: ${formatYamlScalarValue(SKILL_METADATA.description)}\nuser-invocable: true\nallowed-tools: ["Read", "Grep", "Glob", "Bash", "Agent"]\n---\n\n${claudeBody}`;
}

export function renderCodexAgent(role: ReviewerRole, body: string): string {
  const codexName = role.replaceAll("-", "_");
  const meta = REVIEWER_METADATA[role];
  return `name = ${JSON.stringify(codexName)}\ndescription = ${JSON.stringify(meta.description)}\ndeveloper_instructions = """\n${escapeTomlMultilineBasicString(body)}"""\n`;
}

export function renderCodexSkill(body: string): string {
  return renderAntigravitySkill(body);
}
