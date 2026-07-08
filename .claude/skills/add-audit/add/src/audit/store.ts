/**
 * Day-file store — daily NDJSON files under data/audit/, host process is the
 * single writer. Append-only is structural: nothing here can update a line,
 * and retention is unlinking whole files (a literal hard delete). Both
 * transports converge host-side, so single-writer holds by construction.
 *
 * This module throws on fs failure; the fail-open posture (log.error, action
 * proceeds) lives in emit.ts, and the boot-time strictness (refuse to start)
 * lives in init.ts.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import { AUDIT_ENABLED, AUDIT_RETENTION_DAYS } from './config.js';

export const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function dayFilePath(day: string): string {
  return path.join(AUDIT_DIR, `${day}.ndjson`);
}

/**
 * The single append point. `day` buckets the line by the EVENT's own UTC day
 * (emit passes it from event.time), not wall-clock at append — so a line whose
 * emit crossed a UTC-midnight tick still files under its timestamp's day, and a
 * bounded reader query can't whole-day-skip it. Throws on fs failure —
 * emitAuditEvent catches.
 */
export function appendAuditLine(line: string, day: string = utcDay()): void {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.appendFileSync(dayFilePath(day), line + '\n');
}

/** Boot-time writability assert — a zero-byte append is a true write probe. */
export function assertAuditWritable(): void {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.appendFileSync(dayFilePath(utcDay()), '');
}

/** Unlink day-files strictly older than (today UTC − retentionDays). 0 or negative = keep forever. */
export function pruneAuditLog(retentionDays: number = AUDIT_RETENTION_DAYS): void {
  if (retentionDays <= 0) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(AUDIT_DIR);
    // eslint-disable-next-line no-catch-all/no-catch-all -- no audit dir yet means nothing to prune, not an error
  } catch {
    return;
  }
  const horizon = utcDay(new Date(Date.now() - retentionDays * DAY_MS));
  let pruned = 0;
  for (const entry of entries) {
    const m = DAY_FILE_RE.exec(entry);
    if (!m || m[1] >= horizon) continue;
    try {
      fs.unlinkSync(path.join(AUDIT_DIR, entry));
      pruned++;
      // eslint-disable-next-line no-catch-all/no-catch-all -- one stuck file must not stop the prune of the others
    } catch (err) {
      log.error('Audit prune failed to unlink day-file', { file: entry, err });
    }
  }
  if (pruned > 0) log.info('Audit retention pruned day-files', { pruned, retentionDays });
}

let lastPruneDay: string | null = null;

/** Retention prune, throttled to once per UTC day — safe to call every tick. */
export function pruneAuditLogIfDue(): void {
  if (!AUDIT_ENABLED || AUDIT_RETENTION_DAYS <= 0) return;
  const today = utcDay();
  if (lastPruneDay === today) return;
  lastPruneDay = today;
  pruneAuditLog();
}

export function markPrunedToday(): void {
  lastPruneDay = utcDay();
}
