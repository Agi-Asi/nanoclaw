import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '', enabled: true }));

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return state.dataDir;
  },
}));

vi.mock('./config.js', () => ({
  get AUDIT_ENABLED() {
    return state.enabled;
  },
  AUDIT_RETENTION_DAYS: 90,
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let reader: typeof import('./reader.js');
let store: typeof import('./store.js');

beforeEach(async () => {
  state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-reader-'));
  state.enabled = true;
  vi.resetModules();
  store = await import('./store.js');
  reader = await import('./reader.js');
});

afterEach(() => {
  fs.rmSync(state.dataDir, { recursive: true, force: true });
});

function dayString(daysAgo: number): string {
  return store.utcDay(new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000));
}

function isoAt(daysAgo: number, tag: number): string {
  const base = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return `${base.toISOString().slice(0, 10)}T10:00:0${tag}.000Z`;
}

let seq = 0;
function seedEvent(daysAgo: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  const event = {
    event_id: `e-${seq}`,
    time: isoAt(daysAgo, seq % 10),
    schema_version: 1,
    actor: { type: 'human', id: 'host:moshe', email: null, user_id: null, group_ids: null },
    origin: { transport: 'socket' },
    action: 'groups.list',
    resources: [{ type: 'agent_group', id: 'ag-1' }],
    outcome: 'success',
    correlation_id: null,
    details: {},
    ...overrides,
  };
  const dir = path.join(state.dataDir, 'audit');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${dayString(daysAgo)}.ndjson`), JSON.stringify(event) + '\n');
  return event;
}

describe('listAuditEvents', () => {
  it('throws the disabled error rather than returning an empty list', () => {
    state.enabled = false;
    expect(() => reader.listAuditEvents({})).toThrow('audit log is disabled — set AUDIT_ENABLED=true');
  });

  it('returns flat rows newest-first across day-files, honoring --limit', () => {
    seedEvent(2, { event_id: 'old' });
    seedEvent(1, { event_id: 'mid-a' });
    seedEvent(1, { event_id: 'mid-b' });
    seedEvent(0, { event_id: 'new' });

    const rows = reader.listAuditEvents({}) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.event_id)).toEqual(['new', 'mid-b', 'mid-a', 'old']);
    expect(rows[0]).toMatchObject({ actor: 'host:moshe', action: 'groups.list', outcome: 'success' });
    expect(rows[0].resources).toBe('agent_group:ag-1');

    const limited = reader.listAuditEvents({ limit: 2 }) as Array<Record<string, unknown>>;
    expect(limited.map((r) => r.event_id)).toEqual(['new', 'mid-b']);
  });

  it('filters by actor, outcome, correlation, and resource (id or type)', () => {
    seedEvent(0, { event_id: 'a', actor: { type: 'agent', id: 'ag-1' }, outcome: 'denied' });
    seedEvent(0, { event_id: 'b', correlation_id: 'appr-9', resources: [{ type: 'approval', id: 'appr-9' }] });
    seedEvent(0, { event_id: 'c', resources: [{ type: 'user', id: 'slack:U1' }] });

    expect((reader.listAuditEvents({ actor: 'ag-1' }) as unknown[]).length).toBe(1);
    expect((reader.listAuditEvents({ outcome: 'denied' }) as unknown[]).length).toBe(1);
    expect((reader.listAuditEvents({ correlation: 'appr-9' }) as unknown[]).length).toBe(1);
    expect((reader.listAuditEvents({ resource: 'slack:U1' }) as unknown[]).length).toBe(1);
    expect((reader.listAuditEvents({ resource: 'approval' }) as unknown[]).length).toBe(1);
  });

  it('matches actions exactly or by dotted prefix', () => {
    seedEvent(0, { event_id: 'cfg', action: 'groups.config.add-mcp-server' });
    seedEvent(0, { event_id: 'list', action: 'groups.list' });
    seedEvent(0, { event_id: 'other', action: 'sessions.list' });

    expect((reader.listAuditEvents({ action: 'groups' }) as unknown[]).length).toBe(2);
    expect((reader.listAuditEvents({ action: 'groups.config' }) as unknown[]).length).toBe(1);
    expect((reader.listAuditEvents({ action: 'groups.list' }) as unknown[]).length).toBe(1);
    // Prefix means dotted segments, not substrings.
    expect((reader.listAuditEvents({ action: 'group' }) as unknown[]).length).toBe(0);
  });

  it('applies --since/--until with relative and ISO forms', () => {
    seedEvent(5, { event_id: 'old' });
    seedEvent(0, { event_id: 'recent' });

    const relative = reader.listAuditEvents({ since: '2d' }) as Array<Record<string, unknown>>;
    expect(relative.map((r) => r.event_id)).toEqual(['recent']);

    const iso = reader.listAuditEvents({ until: dayString(2) }) as Array<Record<string, unknown>>;
    expect(iso.map((r) => r.event_id)).toEqual(['old']);

    expect(() => reader.listAuditEvents({ since: 'yesterdayish' })).toThrow('invalid --since');
  });

  it('--format ndjson returns the stored lines verbatim', () => {
    const seeded = seedEvent(0, { event_id: 'x1' });
    const out = reader.listAuditEvents({ format: 'ndjson' });
    expect(typeof out).toBe('string');
    expect(JSON.parse(out as string)).toEqual(seeded);
    expect(() => reader.listAuditEvents({ format: 'csv' })).toThrow('invalid --format');
  });

  it('--format ndjson exports every event in the window (no silent 100-row cap)', () => {
    for (let i = 0; i < 150; i++) seedEvent(0, { event_id: `e-${i}` });
    const ndjson = reader.listAuditEvents({ format: 'ndjson' }) as string;
    expect(ndjson.split('\n').length).toBe(150);
    // The table view still caps at the default for readability.
    expect((reader.listAuditEvents({}) as unknown[]).length).toBe(100);
  });

  it('honors an explicit --limit 0 as zero rows, not the default', () => {
    seedEvent(0, { event_id: 'a' });
    expect(reader.listAuditEvents({ limit: 0 })).toEqual([]);
  });

  it('rejects a negative or non-integer --limit', () => {
    expect(() => reader.listAuditEvents({ limit: -1 })).toThrow('invalid --limit');
    expect(() => reader.listAuditEvents({ limit: 'lots' })).toThrow('invalid --limit');
  });

  it('parses a timezone-less --since/--until datetime as UTC, not local', () => {
    expect(reader.parseTimeFlag('2026-07-12T00:00:00', '--since')).toBe(Date.parse('2026-07-12T00:00:00Z'));
    // Date-only already parses UTC; an explicit offset is respected as-is.
    expect(reader.parseTimeFlag('2026-07-12', '--since')).toBe(Date.parse('2026-07-12'));
    expect(reader.parseTimeFlag('2026-07-12T00:00:00+02:00', '--until')).toBe(
      Date.parse('2026-07-12T00:00:00+02:00'),
    );
  });

  it('skips malformed stored lines and still returns the rest', () => {
    seedEvent(0, { event_id: 'good' });
    fs.appendFileSync(path.join(state.dataDir, 'audit', `${dayString(0)}.ndjson`), 'not-json\n');

    const rows = reader.listAuditEvents({}) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.event_id)).toEqual(['good']);
  });

  it('rejects an unknown --outcome value', () => {
    expect(() => reader.listAuditEvents({ outcome: 'meh' })).toThrow('invalid --outcome');
  });

  it('returns empty when nothing has been recorded yet', () => {
    expect(reader.listAuditEvents({})).toEqual([]);
  });
});
