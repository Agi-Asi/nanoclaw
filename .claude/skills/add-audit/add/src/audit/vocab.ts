/**
 * Domain-free event vocabulary — actor and origin constructors shared by the
 * domain-owned `*.audit.ts` adapters (the CLI adapter today; approval and
 * channel adapters attach here in later increments). Pure derivation; nothing
 * here writes the log.
 *
 * Leaf rule: this module (like the rest of src/audit/) may depend on node,
 * config/log, shared types, and the db read layer — never on src/cli/* or
 * src/modules/*. Domain-specific mapping (CLI resources, approval payloads)
 * lives in the adapter file of the domain that owns it.
 */
import os from 'os';

import { getMessagingGroup } from '../db/messaging-groups.js';
import type { AuditOrigin } from './types.js';

/**
 * Host callers stamp `host:<install user>` daemon-side: the ncl socket is
 * 0600 and owned by the install user, so the identity is accurate by
 * construction without peer credentials.
 */
export function hostUser(): string {
  try {
    return os.userInfo().username;
    // eslint-disable-next-line no-catch-all/no-catch-all -- os.userInfo throws on exotic hosts; a fallback actor id beats no audit event
  } catch {
    return process.env.USER || 'unknown';
  }
}

export function containerOrigin(sessionId: string, messagingGroupId: string | null): AuditOrigin {
  const origin: AuditOrigin = { transport: 'container', session_id: sessionId };
  if (messagingGroupId) {
    origin.messaging_group_id = messagingGroupId;
    const channel = getMessagingGroup(messagingGroupId)?.channel_type;
    if (channel) origin.channel = channel;
  }
  return origin;
}
