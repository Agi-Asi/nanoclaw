/**
 * CLI audit adapter (installed by /add-audit) — owns how the dispatcher
 * describes itself to the audit log: the dispatch middleware plus the
 * CLI-specific actor/origin/resource mapping. Composed in dispatch.ts as
 * `export const dispatch = withAudit(dispatchInner)`; business logic there
 * contains zero audit calls.
 *
 * Recording model: the log stores WHO did WHICH action to WHAT target and the
 * outcome — never raw argument VALUES. `details` carries the arg key names
 * that were passed plus a small allowlist of governance-relevant enum fields
 * (role, mode, …) echoed verbatim; everything else is name-only. There is no
 * value redactor because no free-form value is ever written — a secret can't
 * leak from a field that was never stored. Target identifiers (ids, users,
 * groups) are structured and surface separately in `resources`.
 *
 * Loading this module also boots the audit log (writability assert, boot
 * prune, hook lifecycle, maintenance timer): dispatch.ts is imported by both
 * transports during the host's barrel phase, so initAuditLog() runs before
 * any command is accepted — and an enabled box with an unwritable
 * data/audit/ refuses to start.
 */
import { emitAuditEvent } from '../audit/emit.js';
import { initAuditLog } from '../audit/init.js';
import {
  type AuditActor,
  type AuditEventInput,
  type AuditOrigin,
  type AuditOutcome,
  type AuditResource,
} from '../audit/types.js';
import { containerOrigin, hostUser } from '../audit/vocab.js';
import { getPendingApprovalsByAction } from '../db/sessions.js';
import type { PendingApproval } from '../types.js';
import { getResource } from './crud.js';
import type { CallerContext, RequestFrame, ResponseFrame } from './frame.js';
import { commandGuardAction } from './guard.js';
import { type CommandDef, lookup } from './registry.js';

initAuditLog();

// ── CLI mapping ──

/**
 * Host callers stamp `host:<install user>` daemon-side (the ncl socket is
 * 0600 and owned by the install user); container callers are their agent group.
 */
export function actorForCaller(ctx: CallerContext): AuditActor {
  return ctx.caller === 'host' ? { type: 'human', id: `host:${hostUser()}` } : { type: 'agent', id: ctx.agentGroupId };
}

export function originForCaller(ctx: CallerContext): AuditOrigin {
  if (ctx.caller === 'host') return { transport: 'socket' };
  return containerOrigin(ctx.sessionId, ctx.messagingGroupId || null);
}

/**
 * Frame-level args use `--hyphen-keys`; recorded key names use the same
 * underscore form the parsed handlers see. Mirrors crud's normalizeArgs
 * (kept local so audit doesn't depend on a module tests commonly mock).
 */
export function normalizeArgKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k.replace(/-/g, '_')] = v;
  }
  return out;
}

/**
 * Arg values safe to record verbatim: governance-relevant enums that are never
 * secrets and whose value IS the audit-worthy detail (which role was granted,
 * which scope/mode was set). Every other value is dropped — only the presence
 * of the flag (its key) is kept — so no free-form or secret-bearing value ever
 * reaches disk.
 */
const SAFE_VALUE_FIELDS: ReadonlySet<string> = new Set([
  'role',
  'mode',
  'session_mode',
  'cli_scope',
  'access',
  'engage_mode',
  'sender_scope',
  'provider',
  'model',
]);

/** CLI resource plural → audit resource type, where the singular isn't it. */
const RESOURCE_TYPE_OVERRIDES: Record<string, string> = {
  groups: 'agent_group',
  'messaging-groups': 'messaging_group',
  'dropped-messages': 'dropped_message',
  'user-dms': 'user_dm',
};

/**
 * Derive touched/attempted resources from a command's args. Generic by design:
 * `id` → the command's own resource, group/user args → their types, and a bare
 * `{type}` entry when nothing else is known (a denied `users list` still names
 * what was attempted). Ids are structured identifiers, not secrets.
 */
export function resourcesForCli(cmd: CommandDef, args: Record<string, unknown>): AuditResource[] {
  if (!cmd.resource) return [];
  const type = RESOURCE_TYPE_OVERRIDES[cmd.resource] ?? getResource(cmd.resource)?.name ?? cmd.resource;

  const out: AuditResource[] = [];
  const push = (t: string, id: unknown): void => {
    if (typeof id !== 'string' || !id) return;
    if (!out.some((r) => r.type === t && r.id === id)) out.push({ type: t, id });
  };
  push(type, args.id);
  push('agent_group', args.agent_group_id ?? args.group);
  push('user', args.user);
  if (out.length === 0) out.push({ type });
  return out;
}

// ── Command resolution, mirrored for the record ──
// Dispatch resolves the command on a local copy of the frame that never leaves
// it, so the middleware mirrors the one documented mechanic below. The mirror
// is mechanical, and drift only ever degrades a record's detail (a fallback
// action name) — never dispatch behavior, and never an outcome.

/**
 * Mirror of dispatch's command resolution: exact lookup, then the longest
 * registered dash-prefix with the remainder recorded as --id.
 */
function resolveForRecord(req: RequestFrame): { cmd?: CommandDef; args: Record<string, unknown> } {
  const direct = lookup(req.command);
  if (direct) return { cmd: direct, args: req.args };
  let shortened = req.command;
  let idx: number;
  while ((idx = shortened.lastIndexOf('-')) > 0) {
    shortened = shortened.slice(0, idx);
    const fallback = lookup(shortened);
    if (fallback) {
      const tail = req.command.slice(shortened.length + 1);
      return { cmd: fallback, args: { ...req.args, id: req.args.id ?? tail } };
    }
  }
  return { args: req.args };
}

/**
 * The approval row a hold just created for this frame — it gives the pending
 * event the same correlation_id the approved replay will carry as its guard
 * grant. requestApproval keeps the minted id internal, so the row is
 * recovered by the frame id it stored in its payload; no row (e.g. no
 * configured approver) → the hold is still recorded, uncorrelated.
 */
function holdApprovalIdFor(frameId: string): string | null {
  const rows = getPendingApprovalsByAction('cli_command');
  for (let i = rows.length - 1; i >= 0; i--) {
    try {
      const payload = JSON.parse(rows[i].payload) as { frame?: { id?: string } };
      if (payload.frame?.id === frameId) return rows[i].approval_id;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a row with an unparseable payload is simply not this frame's hold
    } catch {
      continue;
    }
  }
  return null;
}

// ── The dispatch middleware ──

type DispatchInner = (
  req: RequestFrame,
  ctx: CallerContext,
  opts?: { grant?: PendingApproval },
) => Promise<ResponseFrame>;

/**
 * Build the audit record for one dispatch. `res` is the response frame, or
 * null when `inner` threw (`err` set) — a crash still leaves a record.
 *
 * Outcome: ok → success (or `approved` when a grant drove the replay),
 * forbidden → denied (captures pre-handler scope denials), approval-pending →
 * pending (the record of a hold), a thrown/other error → failure. A `--help`
 * probe is introspection, not the verb, so it records under a neutral
 * `cli.help` action with no target — never as the real command succeeding.
 * Correlation is the approval id: a replay carries the row as its grant, and a
 * fresh hold recovers the row it just created.
 */
function buildEvent(
  req: RequestFrame,
  ctx: CallerContext,
  opts: { grant?: PendingApproval },
  res: ResponseFrame | null,
  err: unknown,
): AuditEventInput {
  const resolved = resolveForRecord(req);
  const cmd = resolved.cmd;
  const normArgs = normalizeArgKeys(resolved.args);

  const isHelp = req.args.help === true && !!res && res.ok;
  const pending = !!res && !res.ok && res.error.code === 'approval-pending';
  const approved = !!res && res.ok && !!opts.grant && !isHelp;

  const outcome: AuditOutcome = !res
    ? 'failure' // inner threw
    : res.ok
      ? approved
        ? 'approved'
        : 'success'
      : res.error.code === 'forbidden'
        ? 'denied'
        : pending
          ? 'pending'
          : 'failure';

  // details: arg key names + allowlisted safe values only. No free-form value
  // is ever stored, so nothing needs redacting and nothing can leak.
  const details: Record<string, unknown> = { args: Object.keys(normArgs).sort() };
  for (const f of SAFE_VALUE_FIELDS) {
    if (normArgs[f] !== undefined) details[f] = normArgs[f];
  }
  if (err) {
    details.error = 'exception'; // the throw's message is never stored
  } else if (res && !res.ok && !pending) {
    details.error = res.error.code; // the error CODE (a safe enum), never the free-text message
  }
  if (!cmd) details.command = req.command;

  const correlationId = opts.grant?.approval_id ?? (pending ? holdApprovalIdFor(req.id) : null);

  const action = isHelp ? 'cli.help' : cmd ? commandGuardAction(cmd) : 'cli.unknown-command';
  const resources: AuditResource[] = isHelp ? [] : cmd ? resourcesForCli(cmd, normArgs) : [];
  if (correlationId) resources.push({ type: 'approval', id: correlationId });

  return {
    actor: actorForCaller(ctx),
    origin: originForCaller(ctx),
    action,
    resources,
    outcome,
    correlationId,
    details,
  };
}

/**
 * Dispatch middleware — the exported `dispatch` is the wrapped function, so
 * the socket server, the container delivery-action, and the in-module
 * approved replay are all covered by the one composition.
 *
 * The emit brackets `inner` so a thrown dispatcher still leaves a record: on
 * throw we emit a `failure` event and re-raise unchanged, so an approval-gated
 * command whose hold crashes on the DB write is not a silent governance gap.
 */
export function withAudit(inner: DispatchInner): DispatchInner {
  return async (req, ctx, opts = {}) => {
    let res: ResponseFrame;
    try {
      res = await inner(req, ctx, opts);
    } catch (err) {
      emitAuditEvent(() => buildEvent(req, ctx, opts, null, err));
      throw err;
    }
    emitAuditEvent(() => buildEvent(req, ctx, opts, res, null));
    return res;
  };
}
