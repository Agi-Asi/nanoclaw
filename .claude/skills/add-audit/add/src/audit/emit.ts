/**
 * The single emit seam. Adapters import emitAuditEvent from here directly
 * (it is deliberately not re-exported by the barrel): only src/audit/ and
 * `*.audit.ts` adapter files may call it — grep holds the invariant.
 *
 * The opt-in check lives here, so the whole feature switches at one point.
 * Fail-open + loud: a failed append (or a throwing input thunk) is
 * log.error'd and the audited action proceeds.
 */
import { randomUUID } from 'crypto';

import { log } from '../log.js';
import { AUDIT_ENABLED } from './config.js';
import { notifyAuditHooks } from './hooks.js';
import { appendAuditLine } from './store.js';
import type { AuditEvent, AuditEventInput } from './types.js';

export function emitAuditEvent(input: AuditEventInput | (() => AuditEventInput)): void {
  if (!AUDIT_ENABLED) return; // The one opt-in check — the whole feature switches here.
  try {
    if (typeof input === 'function') input = input();
    const event: AuditEvent = {
      event_id: randomUUID(),
      time: new Date().toISOString(),
      schema_version: 1,
      actor: { ...input.actor, email: null, user_id: null, group_ids: null },
      origin: input.origin,
      action: input.action,
      resources: input.resources,
      outcome: input.outcome,
      correlation_id: input.correlationId ?? null,
      // Adapters build `details` value-free (key names + an enum allowlist), so
      // there is nothing to redact here — a secret can't leak from a value that
      // is never stored. Written verbatim.
      details: input.details ?? {},
    };
    const line = JSON.stringify(event);
    appendAuditLine(line, event.time.slice(0, 10));
    notifyAuditHooks(event, line);
    // eslint-disable-next-line no-catch-all/no-catch-all -- fail-open is the posture: an audit failure must never take down the audited action
  } catch (err) {
    const action = typeof input === 'function' ? undefined : input.action;
    log.error('Audit append failed — action proceeding (fail-open)', { action, err });
  }
}
