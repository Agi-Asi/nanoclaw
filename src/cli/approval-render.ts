/**
 * Pure renderers for the cli_command approval flow: the card body an admin
 * reads before signing off on an agent's held `ncl` command, and the note the
 * agent receives after the decision. Leaf formatting module — strings in,
 * strings out, no DB or transport — so the card stays testable on its own and
 * dispatch.ts touches it with one call per surface.
 *
 * The card body IS the thing being approved, so it must be readable: the
 * command on one line, each arg on its own line, and any arg value that parses
 * as JSON pretty-printed as an indented block — a registered manifest renders
 * as structure, never as escape soup. The whole command lands in one fenced
 * code block (CardText becomes Slack mrkdwn, where the fence preserves the
 * indentation); backticks inside values get an invisible word joiner appended
 * so they can never close the fence. All truncation drops whole lines or whole
 * code points and leaves a marker — never half an escape sequence.
 */
import { indent } from './help-render.js';

/** Longest inline value / pretty-printed JSON line before truncation. */
const INLINE_VALUE_LIMIT = 400;
/** Card body budget — Slack section text caps at 3000; leave headroom. */
const CARD_BODY_LIMIT = 2800;
/** Post-approval result budget — a chat note, not a data channel. */
const RESULT_LIMIT = 4000;

/** Card body for a held CLI command: who wants to run what, readably. */
export function cliApprovalQuestion(agentName: string, command: string, args: Record<string, unknown>): string {
  const block = clampWholeLines(guardFence(formatCliCommand(command, args)), CARD_BODY_LIMIT);
  return `Agent "${agentName}" wants to run:\n\`\`\`\n${block}\n\`\`\``;
}

/**
 * Agent-facing note for an approved-and-executed command. Attribution is the
 * role, never a platform user id — the agent has no use for the internal id,
 * and the approver chain is exactly the admin chain (finalizeReject speaks the
 * same way). `result` is the command's human rendering when it has one.
 */
export function cliApprovalExecuted(command: string, result: string | undefined): string {
  const note = `Your \`ncl ${command}\` request was approved by an admin and the command ran.`;
  const trimmed = result?.trim();
  return trimmed ? `${note}\n\nResult:\n${clampWholeLines(trimmed, RESULT_LIMIT)}` : note;
}

/** Agent-facing note for an approved command whose replay failed. */
export function cliApprovalFailed(command: string, message: string): string {
  return `Your \`ncl ${command}\` request was approved by an admin, but the command failed: ${message}`;
}

/**
 * `ncl <command>` plus one line per arg. A value that is (or parses as) a
 * JSON object/array becomes an indented pretty-printed block under its flag;
 * `true` renders as a bare flag; everything else stays inline. Plain text —
 * fence concerns belong to cliApprovalQuestion.
 */
export function formatCliCommand(command: string, args: Record<string, unknown>): string {
  const lines = [`ncl ${command}`];
  for (const [key, value] of Object.entries(args)) {
    const block = jsonBlock(value);
    if (block !== undefined) {
      lines.push(`  --${key}`, indent(block, '    '));
    } else if (value === true) {
      lines.push(`  --${key}`);
    } else {
      lines.push(`  --${key} ${truncateInline(String(value), INLINE_VALUE_LIMIT)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Pretty-printed JSON for structured values, undefined for everything else.
 * Strings are parsed so an escaped `--config` manifest becomes structure;
 * scalars that happen to parse ("8080") stay inline. Each output line is
 * individually truncated so one huge embedded string can't eat the card.
 */
function jsonBlock(value: unknown): string | undefined {
  let structured: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
    try {
      structured = JSON.parse(trimmed);
    } catch {
      return undefined; // JSON-shaped but not JSON — inline like any scalar
    }
  }
  if (structured === null || typeof structured !== 'object') return undefined;
  return JSON.stringify(structured, null, 2)
    .split('\n')
    .map((line) => truncateInline(line, INLINE_VALUE_LIMIT))
    .join('\n');
}

/**
 * Code-point-safe truncation with a marker. Slicing by code point never splits
 * a surrogate pair, and an odd run of trailing backslashes (a cut-open escape
 * like `\u12`… or a dangling `\`) drops one more so the marker never lands
 * mid-escape.
 */
function truncateInline(value: string, limit: number): string {
  const points = [...value];
  if (points.length <= limit) return value;
  let cut = points.slice(0, limit).join('');
  const trailing = /\\+$/.exec(cut)?.[0].length ?? 0;
  if (trailing % 2 === 1) cut = cut.slice(0, -1);
  return `${cut}… [truncated]`;
}

/** Keep whole leading lines up to `limit` chars; the dropped tail becomes one marker line. */
function clampWholeLines(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const kept: string[] = [];
  let length = 0;
  for (const line of text.split('\n')) {
    if (length + line.length + 1 > limit) break;
    kept.push(line);
    length += line.length + 1;
  }
  kept.push('… [truncated]');
  return kept.join('\n');
}

/**
 * A backtick run inside the card's fenced body must never close the fence.
 * Slack renders the word joiner (U+2060) invisibly, so appending it to each
 * backtick keeps the characters readable while breaking any ``` sequence.
 */
function guardFence(text: string): string {
  return text.replace(/`/g, '`\u2060');
}
