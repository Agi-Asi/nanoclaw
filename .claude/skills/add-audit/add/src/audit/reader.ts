/**
 * Read-back for `ncl audit list` — a newest-first stream-scan over the
 * day-files. No index: fine at v1 volume, and adding one later doesn't change
 * the store. NDJSON export returns the stored lines verbatim.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';
import { AUDIT_ENABLED } from './config.js';
import { AUDIT_DIR, utcDay } from './store.js';
import type { AuditEvent, AuditOutcome } from './types.js';

const OUTCOMES: ReadonlySet<string> = new Set(['success', 'failure', 'denied', 'pending', 'approved']);
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;
const DEFAULT_LIMIT = 100;

export interface AuditQuery {
  actor?: string;
  /** Exact action or dotted prefix (`groups` matches `groups.config.update`). */
  action?: string;
  /** Matches any resources[] entry by id or by type. */
  resource?: string;
  outcome?: AuditOutcome;
  sinceMs?: number;
  untilMs?: number;
  correlation?: string;
  limit: number;
}

/** `7d` / `24h` / `30m` relative to now, or an ISO date/datetime (UTC). */
export function parseTimeFlag(value: string, flag: string): number {
  const rel = /^(\d+)([dhm])$/.exec(value);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs = rel[2] === 'd' ? 86_400_000 : rel[2] === 'h' ? 3_600_000 : 60_000;
    return Date.now() - n * unitMs;
  }
  // A timezone-less ISO *datetime* parses as LOCAL per spec, but --since/--until
  // are documented UTC; append 'Z' so a bare datetime reads as UTC. Date-only
  // forms already parse as UTC, and an explicit offset (`+02:00`/`Z`) is left as-is.
  const normalized = /^\d{4}-\d{2}-\d{2}T[\d.:]+$/.test(value) ? `${value}Z` : value;
  const abs = Date.parse(normalized);
  if (!Number.isNaN(abs)) return abs;
  throw new Error(`invalid ${flag} value "${value}" — use e.g. 7d, 24h, 30m, or an ISO date`);
}

/** Newest first across files and within each file, up to q.limit. */
export function queryAuditEvents(q: AuditQuery): { events: AuditEvent[]; lines: string[] } {
  const events: AuditEvent[] = [];
  const lines: string[] = [];
  let malformed = 0;

  for (const { day, file } of dayFilesNewestFirst()) {
    if (events.length >= q.limit) break;
    // Whole-day skip: a file can't match a window its day lies outside.
    if (q.sinceMs !== undefined && day < utcDay(new Date(q.sinceMs))) continue;
    if (q.untilMs !== undefined && day > utcDay(new Date(q.untilMs))) continue;

    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
      // eslint-disable-next-line no-catch-all/no-catch-all -- a torn/pruned day-file must not fail the whole query
    } catch (err) {
      log.warn('Audit reader failed to read day-file', { file, err });
      continue;
    }
    const fileLines = content.split('\n').filter((l) => l.trim() !== '');
    // Lines within a file are chronological — walk backwards for newest-first.
    for (let i = fileLines.length - 1; i >= 0 && events.length < q.limit; i--) {
      let event: AuditEvent;
      try {
        event = JSON.parse(fileLines[i]) as AuditEvent;
        // eslint-disable-next-line no-catch-all/no-catch-all -- malformed stored lines are skipped (counted + warned below)
      } catch {
        malformed++;
        continue;
      }
      if (!matches(event, q)) continue;
      events.push(event);
      lines.push(fileLines[i]);
    }
  }

  if (malformed > 0) {
    log.warn('Audit reader skipped malformed lines', { malformed });
  }
  return { events, lines };
}

function dayFilesNewestFirst(): Array<{ day: string; file: string }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(AUDIT_DIR);
    // eslint-disable-next-line no-catch-all/no-catch-all -- no audit dir yet means no events, not an error
  } catch {
    return [];
  }
  return entries
    .map((e) => DAY_FILE_RE.exec(e))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ day: m[1], file: path.join(AUDIT_DIR, m[0]) }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

function matches(event: AuditEvent, q: AuditQuery): boolean {
  if (q.actor !== undefined && event.actor?.id !== q.actor) return false;
  if (q.action !== undefined && event.action !== q.action && !event.action?.startsWith(q.action + '.')) return false;
  if (q.outcome !== undefined && event.outcome !== q.outcome) return false;
  if (q.correlation !== undefined && event.correlation_id !== q.correlation) return false;
  if (q.resource !== undefined) {
    const hit = (event.resources ?? []).some((r) => r.id === q.resource || r.type === q.resource);
    if (!hit) return false;
  }
  const t = Date.parse(event.time ?? '');
  if (q.sinceMs !== undefined && !(t >= q.sinceMs)) return false;
  if (q.untilMs !== undefined && !(t <= q.untilMs)) return false;
  return true;
}

/**
 * `ncl audit list` handler. Disabled → an explicit error: an empty list would
 * read as "no actions happened", which is a different truth than "not
 * recording". `--format ndjson` returns the stored lines verbatim (the human
 * formatter passes strings through); default returns flat rows for the table.
 */
export function listAuditEvents(args: Record<string, unknown>): string | Array<Record<string, unknown>> {
  if (!AUDIT_ENABLED) {
    throw new Error('audit log is disabled — set AUDIT_ENABLED=true');
  }

  const format = args.format !== undefined ? String(args.format) : '';
  if (format && format !== 'ndjson') {
    throw new Error(`invalid --format "${format}" — only "ndjson" is supported`);
  }
  const outcome = args.outcome !== undefined ? String(args.outcome) : undefined;
  if (outcome !== undefined && !OUTCOMES.has(outcome)) {
    throw new Error(`invalid --outcome "${outcome}" — one of: ${[...OUTCOMES].join(', ')}`);
  }

  // An explicit --limit is honored exactly (0 means 0, not "default"). Absent,
  // the table view caps at DEFAULT_LIMIT for readability, but ndjson — the SIEM
  // export path — is bounded only by --since/--until, never silently truncated.
  let limit: number;
  if (args.limit !== undefined) {
    const n = Number(args.limit);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`invalid --limit "${String(args.limit)}" — use a non-negative integer`);
    }
    limit = n;
  } else {
    limit = format === 'ndjson' ? Infinity : DEFAULT_LIMIT;
  }

  const q: AuditQuery = {
    actor: args.actor !== undefined ? String(args.actor) : undefined,
    action: args.action !== undefined ? String(args.action) : undefined,
    resource: args.resource !== undefined ? String(args.resource) : undefined,
    outcome: outcome as AuditOutcome | undefined,
    correlation: args.correlation !== undefined ? String(args.correlation) : undefined,
    sinceMs: args.since !== undefined ? parseTimeFlag(String(args.since), '--since') : undefined,
    untilMs: args.until !== undefined ? parseTimeFlag(String(args.until), '--until') : undefined,
    limit,
  };

  const { events, lines } = queryAuditEvents(q);
  if (format === 'ndjson') return lines.join('\n');

  return events.map((e) => ({
    time: e.time,
    actor: e.actor?.id ?? '',
    action: e.action,
    resources: (e.resources ?? []).map((r) => (r.id ? `${r.type}:${r.id}` : r.type)).join(' '),
    outcome: e.outcome,
    correlation: e.correlation_id ?? '',
    event_id: e.event_id,
  }));
}
