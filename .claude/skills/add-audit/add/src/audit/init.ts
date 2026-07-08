/**
 * Boot-time audit wiring, self-contained (installed by /add-audit).
 *
 * initAuditLog() runs at module load of the CLI audit adapter
 * (cli/dispatch.audit.ts) — i.e. during the host's barrel phase, before the
 * CLI server or any delivery poll accepts work — because dispatch.ts, which
 * both transports import, composes withAudit at module scope. When enabled:
 * assert data/audit/ is writable (refusing to start beats running with a
 * silent audit gap), run the boot prune, start the registered post-write
 * hooks, and arm the maintenance timer.
 *
 * The timer owns the daily cadence in-module (checked hourly; the prune
 * itself fires at most once per UTC day) so installing the skill touches
 * dispatch.ts and the resource barrel only — no host-sweep edit. It is
 * unref'd: it never keeps the process alive.
 */
import { log } from '../log.js';
import { onShutdown } from '../response-registry.js';
import { AUDIT_ENABLED, AUDIT_RETENTION_DAYS } from './config.js';
import { initAuditHooks, maintainAuditHooks, shutdownAuditHooks } from './hooks.js';
import { assertAuditWritable, AUDIT_DIR, markPrunedToday, pruneAuditLog, pruneAuditLogIfDue } from './store.js';

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

let initialized = false;

export function initAuditLog(): void {
  if (!AUDIT_ENABLED || initialized) return;
  initialized = true;
  try {
    assertAuditWritable();
  } catch (err) {
    throw new Error(
      `AUDIT_ENABLED=true but the audit directory is not writable: ${AUDIT_DIR} (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  pruneAuditLog();
  markPrunedToday();
  initAuditHooks(); // throw → boot fails, same posture as the writability assert
  onShutdown(() => shutdownAuditHooks());
  setInterval(maintainAudit, MAINTENANCE_INTERVAL_MS).unref();
  log.info('Audit log enabled', { dir: AUDIT_DIR, retentionDays: AUDIT_RETENTION_DAYS });
}

/**
 * One maintenance tick: retention prune (throttled to once per UTC day
 * internally) plus every hook's periodic maintenance. No-op when audit is
 * disabled. Exported so a future scheduler can drive it too.
 */
export function maintainAudit(): void {
  pruneAuditLogIfDue();
  if (AUDIT_ENABLED) maintainAuditHooks();
}
