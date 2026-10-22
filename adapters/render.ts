import { ReviewerRole, REVIEWER_METADATA, SKILL_METADATA } from "./types.js";

/**
 * 平台渲染引擎：将 Canonical Markdown 正文与各平台专有元数据/包装层动态拼接。
 * 实现 100% 字节兼容，消除三平台在 Agent 正文与 Skill 正文上的物理重复（R-01 / R-02）。
 */

export function renderAntigravityAgent(role: ReviewerRole, body: string): string {
  const meta = REVIEWER_METADATA[role];
  return `---\nname: ${role}\ndescription: >-\n  ${meta.description}\n---\n\n${body}`;
}

export function renderAntigravitySkill(body: string): string {
  return `---\nname: ${SKILL_METADATA.name}\ndescription: ${SKILL_METADATA.description}\n---\n\n${body}`;
}

export function renderClaudeAgent(role: ReviewerRole, body: string): string {
  const meta = REVIEWER_METADATA[role];
  return `---\nname: ${role}\ndescription: >-\n  ${meta.description}\ntools: Read, Grep, Glob, Bash\n---\n\n${body}`;
}

export function renderClaudeSkill(body: string): string {
  const claudeBody = body.replace(
    "# Independent code review\n\n",
    "# Independent code review\n\nArguments: $ARGUMENTS\n\n"
  );
  return `---\nname: ${SKILL_METADATA.name}\ndescription: ${SKILL_METADATA.description}\nuser-invocable: true\nallowed-tools: ["Read", "Grep", "Glob", "Bash", "Agent"]\n---\n\n${claudeBody}`;
}

export function renderCodexAgent(role: ReviewerRole, body: string): string {
  const codexName = role.replaceAll("-", "_");
  const meta = REVIEWER_METADATA[role];
  return `name = "${codexName}"\ndescription = "${meta.description}"\ndeveloper_instructions = """\n${body}"""\n`;
}

export function renderCodexSkill(body: string): string {
  return renderAntigravitySkill(body);
}
