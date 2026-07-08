import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Core config (DATA_DIR) and the audit config (toggles) are mocked so
// store/emit resolve a per-test temp DATA_DIR and audit switches. Getters
// keep the values live across vi.resetModules().
const state = vi.hoisted(() => ({ dataDir: '', enabled: true, retention: 90 }));

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return state.dataDir;
  },
}));

vi.mock('./config.js', () => ({
  get AUDIT_ENABLED() {
    return state.enabled;
  },
  get AUDIT_RETENTION_DAYS() {
    return state.retention;
  },
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let store: typeof import('./store.js');
let emit: typeof import('./emit.js');
let log: (typeof import('../log.js'))['log'];

beforeEach(async () => {
  state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-store-'));
  state.enabled = true;
  state.retention = 90;
  vi.resetModules();
  store = await import('./store.js');
  emit = await import('./emit.js');
  log = (await import('../log.js')).log;
  vi.clearAllMocks();
});

afterEach(() => {
  fs.chmodSync(path.join(state.dataDir), 0o700);
  const auditDir = path.join(state.dataDir, 'audit');
  if (fs.existsSync(auditDir)) fs.chmodSync(auditDir, 0o700);
  fs.rmSync(state.dataDir, { recursive: true, force: true });
});

function auditDir(): string {
  return path.join(state.dataDir, 'audit');
}

function writeDayFile(day: string, lines = 1): void {
  fs.mkdirSync(auditDir(), { recursive: true });
  fs.writeFileSync(path.join(auditDir(), `${day}.ndjson`), '{"x":1}\n'.repeat(lines));
}

function dayString(daysAgo: number): string {
  return store.utcDay(new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000));
}

const EVENT_INPUT = {
  actor: { type: 'human' as const, id: 'host:test' },
  origin: { transport: 'socket' as const },
  action: 'groups.list',
  resources: [{ type: 'agent_group' }],
  outcome: 'success' as const,
};

describe('appendAuditLine', () => {
  it("appends one line to today's UTC day-file, creating the directory lazily", () => {
    expect(fs.existsSync(auditDir())).toBe(false);
    store.appendAuditLine('{"a":1}');
    store.appendAuditLine('{"b":2}');
    const file = path.join(auditDir(), `${store.utcDay()}.ndjson`);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it('buckets by the given event day, not wall-clock at append', () => {
    store.appendAuditLine('{"c":3}', '2020-01-02');
    expect(fs.readFileSync(path.join(auditDir(), '2020-01-02.ndjson'), 'utf8')).toBe('{"c":3}\n');
    // Today's file is untouched — the line filed under its own day.
    expect(fs.existsSync(path.join(auditDir(), `${store.utcDay()}.ndjson`))).toBe(false);
  });
});

describe('emitAuditEvent', () => {
  it('writes a schema_version-1 record with envelope fields and null enrichment', () => {
    emit.emitAuditEvent({ ...EVENT_INPUT, details: { limit: 100 } });
    const file = path.join(auditDir(), `${store.utcDay()}.ndjson`);
    const record = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(record).toMatchObject({
      schema_version: 1,
      actor: { type: 'human', id: 'host:test', email: null, user_id: null, group_ids: null },
      origin: { transport: 'socket' },
      action: 'groups.list',
      outcome: 'success',
      correlation_id: null,
      details: { limit: 100 },
    });
    expect(record.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(record.time).toISOString()).toBe(record.time);
  });

  it('stores details verbatim — the emit seam performs no value transformation', () => {
    // emit is domain-free: adapters build `details` value-free, so there is
    // nothing to redact here. Whatever is passed is written as-is.
    emit.emitAuditEvent({ ...EVENT_INPUT, details: { args: ['role'], role: 'admin' } });
    const file = path.join(auditDir(), `${store.utcDay()}.ndjson`);
    const record = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(record.details).toEqual({ args: ['role'], role: 'admin' });
  });

  it('is a no-op when audit is disabled — the directory is never created', () => {
    state.enabled = false;
    emit.emitAuditEvent(EVENT_INPUT);
    expect(fs.existsSync(auditDir())).toBe(false);
  });

  it('fails open and loud when the append fails', () => {
    fs.mkdirSync(auditDir(), { recursive: true });
    fs.chmodSync(auditDir(), 0o500);
    expect(() => emit.emitAuditEvent(EVENT_INPUT)).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Audit append failed'),
      expect.objectContaining({ action: 'groups.list' }),
    );
  });
});

describe('assertAuditWritable', () => {
  it('creates the directory and probes it with a zero-byte append', () => {
    store.assertAuditWritable();
    expect(fs.existsSync(path.join(auditDir(), `${store.utcDay()}.ndjson`))).toBe(true);
  });

  it('throws when the directory is not writable', () => {
    fs.mkdirSync(auditDir(), { recursive: true });
    fs.chmodSync(auditDir(), 0o500);
    expect(() => store.assertAuditWritable()).toThrow();
  });
});

describe('pruneAuditLog', () => {
  it('unlinks only day-files strictly older than the horizon', () => {
    writeDayFile(dayString(100));
    writeDayFile(dayString(91));
    writeDayFile(dayString(90));
    writeDayFile(dayString(1));
    fs.writeFileSync(path.join(auditDir(), 'not-a-day-file.txt'), 'keep');
    fs.writeFileSync(path.join(auditDir(), '2026-01-01.ndjson.bak'), 'keep');
    store.pruneAuditLog(90);
    const left = fs.readdirSync(auditDir()).sort();
    expect(left).toEqual(
      [`${dayString(90)}.ndjson`, `${dayString(1)}.ndjson`, '2026-01-01.ndjson.bak', 'not-a-day-file.txt'].sort(),
    );
  });

  it('keeps forever when retention is 0', () => {
    writeDayFile(dayString(400));
    store.pruneAuditLog(0);
    expect(fs.existsSync(path.join(auditDir(), `${dayString(400)}.ndjson`))).toBe(true);
  });

  it('is a no-op when the audit directory does not exist', () => {
    expect(() => store.pruneAuditLog(90)).not.toThrow();
  });
});

describe('pruneAuditLogIfDue', () => {
  it('prunes at most once per UTC day', () => {
    writeDayFile(dayString(100));
    store.pruneAuditLogIfDue();
    expect(fs.existsSync(path.join(auditDir(), `${dayString(100)}.ndjson`))).toBe(false);
    writeDayFile(dayString(100));
    store.pruneAuditLogIfDue();
    expect(fs.existsSync(path.join(auditDir(), `${dayString(100)}.ndjson`))).toBe(true);
  });

  it('does nothing when audit is disabled', () => {
    state.enabled = false;
    writeDayFile(dayString(100));
    store.pruneAuditLogIfDue();
    expect(fs.existsSync(path.join(auditDir(), `${dayString(100)}.ndjson`))).toBe(true);
  });

  it('does nothing after markPrunedToday until the day rolls over', () => {
    store.markPrunedToday();
    writeDayFile(dayString(100));
    store.pruneAuditLogIfDue();
    expect(fs.existsSync(path.join(auditDir(), `${dayString(100)}.ndjson`))).toBe(true);
  });
});
