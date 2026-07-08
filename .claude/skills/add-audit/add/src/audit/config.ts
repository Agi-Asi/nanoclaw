/**
 * Audit env config (installed by /add-audit) — the two audit vars, read the
 * same way src/config.ts reads every host setting (readEnvFile from .env,
 * with process.env taking precedence). Kept audit-owned so installing the
 * skill never edits core config.ts: the feature's whole footprint in core is
 * the dispatch composition in dispatch.ts and the resource-barrel import.
 */
import { readEnvFile } from '../env.js';

const envConfig = readEnvFile(['AUDIT_ENABLED', 'AUDIT_RETENTION_DAYS']);

/**
 * Master switch. Off by default — nothing is persisted (and data/audit/ is
 * never created) until an operator sets AUDIT_ENABLED=true.
 */
export const AUDIT_ENABLED = (process.env.AUDIT_ENABLED || envConfig.AUDIT_ENABLED) === 'true';

/**
 * Day-file retention horizon in days; consulted only when audit is enabled.
 * Unset or unparseable → 90. An explicit 0 (or negative) = keep forever.
 */
function parseRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 90;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? 90 : n;
}

export const AUDIT_RETENTION_DAYS = parseRetentionDays(
  process.env.AUDIT_RETENTION_DAYS || envConfig.AUDIT_RETENTION_DAYS,
);
