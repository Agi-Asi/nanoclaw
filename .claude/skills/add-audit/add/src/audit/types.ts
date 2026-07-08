/**
 * Canonical audit event — one flat, SIEM-shaped record per action.
 *
 * Fields are chosen so they project losslessly onto OCSF and Elastic ECS
 * (the two schemas SIEMs converge on); the store keeps the neutral shape and
 * a future forwarder pays the translation once, at the edge. `schema_version`
 * covers evolution — additive changes only within a version.
 */

export type AuditActorType = 'human' | 'agent' | 'system';

export interface AuditActor {
  type: AuditActorType;
  /** `host:<os-user>` | `<channel>:<handle>` | agent group id | `host` (system). */
  id: string;
}

export interface AuditOrigin {
  transport: 'socket' | 'container' | 'channel';
  session_id?: string;
  messaging_group_id?: string;
  channel?: string;
}

export interface AuditResource {
  type: string;
  /** Omitted when only the attempted type is known (e.g. a denied list). */
  id?: string;
}

export type AuditOutcome = 'success' | 'failure' | 'denied' | 'pending' | 'approved';

/** What emit sites provide. Envelope fields are stamped by emitAuditEvent. */
export interface AuditEventInput {
  actor: AuditActor;
  origin: AuditOrigin;
  /** Dotted namespaced verb, e.g. `groups.config.add-mcp-server`. */
  action: string;
  resources: AuditResource[];
  outcome: AuditOutcome;
  /** The approval id on gated chains; null/omitted otherwise. */
  correlationId?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditEvent {
  event_id: string;
  time: string;
  schema_version: 1;
  actor: AuditActor & { email: null; user_id: null; group_ids: null };
  origin: AuditOrigin;
  action: string;
  resources: AuditResource[];
  outcome: AuditOutcome;
  correlation_id: string | null;
  details: Record<string, unknown>;
}
