/**
 * Audit middleware behavior of the exported dispatch — what gets recorded,
 * for whom, and how gated chains correlate. Drives the real wrapped dispatch
 * (real registry, real guard); audit is force-enabled and the store's append
 * is captured. DB reads and approval delivery are mocked.
 *
 * Recording model under test: the log stores arg KEY NAMES plus a small
 * allowlist of safe enum values — never raw argument values — so a
 * secret-bearing arg leaves only its key behind.
 */
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval } from '../types.js';

const appended = vi.hoisted(() => ({ lines: [] as string[] }));
const pendingRows = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('../audit/config.js', () => ({
  AUDIT_ENABLED: true,
  AUDIT_RETENTION_DAYS: 90,
}));

// Neutralize the adapter's module-scope boot (writability assert, prune,
// maintenance timer) — the middleware is the unit under test here.
vi.mock('../audit/init.js', () => ({
  initAuditLog: vi.fn(),
  maintainAudit: vi.fn(),
}));

vi.mock('../audit/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audit/store.js')>();
  return {
    ...actual,
    appendAuditLine: (line: string) => {
      appended.lines.push(line);
    },
  };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const mockGetContainerConfig = vi.fn();
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
}));

vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(() => ({ id: 'g1', name: 'Group One' })),
}));

const mockGetPendingApproval = vi.fn();
vi.mock('../db/sessions.js', () => ({
  getSession: vi.fn(() => ({ id: 's1', agent_group_id: 'g1', messaging_group_id: 'mg1' })),
  getPendingApproval: (...args: unknown[]) => mockGetPendingApproval(...args),
  getPendingApprovalsByAction: () => pendingRows.rows,
}));

vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn(() => ({ channel_type: 'slack' })),
}));

const mockGetResource = vi.fn();
vi.mock('./crud.js', () => ({
  getResource: (...args: unknown[]) => mockGetResource(...args),
}));

const mockRequestApproval = vi.fn();
vi.mock('../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: (...args: unknown[]) => mockRequestApproval(...args),
}));

import { register } from './registry.js';

register({
  name: 'groups-test',
  description: 'echo command on the groups resource',
  action: 'groups.test',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'groups-get',
  description: 'echo command for dash-joined id resolution',
  action: 'groups.get',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'wirings-list',
  description: 'not on the group-scope allowlist',
  action: 'wirings.list',
  resource: 'wirings',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => [],
});

register({
  name: 'groups-fail',
  description: 'handler that throws',
  action: 'groups.fail',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => {
    throw new Error('boom');
  },
});

register({
  name: 'groups-gated',
  description: 'approval-gated command',
  action: 'groups.gated',
  resource: 'groups',
  access: 'approval',
  parseArgs: (raw) => raw,
  handler: async () => 'ran',
});

register({
  name: 'roles-grant',
  description: 'command carrying an allowlisted --role value',
  action: 'roles.grant',
  resource: 'roles',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => ({ granted: true }),
});

import { dispatch } from './dispatch.js';
import type { CallerContext } from './frame.js';

const AGENT_CTX: CallerContext = { caller: 'agent', sessionId: 's1', agentGroupId: 'g1', messagingGroupId: 'mg1' };

function grantRow(frameId: string, command: string): PendingApproval {
  return {
    approval_id: 'appr-123-abc',
    session_id: 's1',
    request_id: 'appr-123-abc',
    action: 'cli_command',
    payload: JSON.stringify({ frame: { id: frameId, command, args: {} }, callerContext: AGENT_CTX }),
    created_at: new Date().toISOString(),
    agent_group_id: 'g1',
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: 'CLI: groups-gated',
    options_json: '[]',
    approver_user_id: null,
  };
}

function events(): Array<Record<string, any>> {
  return appended.lines.map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.clearAllMocks();
  appended.lines.length = 0;
  pendingRows.rows = [];
  mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
  mockGetResource.mockImplementation((plural: string) => (plural === 'groups' ? { scopeField: 'id' } : undefined));
  mockRequestApproval.mockResolvedValue(undefined);
});

describe('withAudit(dispatch)', () => {
  it('records a success event for a host caller with socket origin and host actor', async () => {
    const resp = await dispatch({ id: '1', command: 'groups-test', args: { foo: 'bar' } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const [event] = events();
    expect(event).toMatchObject({
      schema_version: 1,
      actor: { type: 'human', id: `host:${os.userInfo().username}`, email: null },
      origin: { transport: 'socket' },
      action: 'groups.test',
      outcome: 'success',
      correlation_id: null,
      details: { args: ['foo'] },
    });
    // The value 'bar' is never stored — only the key name.
    expect(event.details.foo).toBeUndefined();
  });

  it('records an agent command value-free, with container origin and channel', async () => {
    await dispatch({ id: '1', command: 'groups-test', args: {} }, AGENT_CTX);

    const [event] = events();
    expect(event.actor).toMatchObject({ type: 'agent', id: 'g1' });
    expect(event.origin).toEqual({
      transport: 'container',
      session_id: 's1',
      messaging_group_id: 'mg1',
      channel: 'slack',
    });
    expect(event.details).toEqual({ args: [] });
    expect(event.resources).toContainEqual({ type: 'agent_group' });
  });

  it('records the passed flag names and echoes allowlisted safe values verbatim', async () => {
    await dispatch(
      { id: '1', command: 'roles-grant', args: { role: 'admin', user: 'slack:U1' } },
      { caller: 'host' },
    );

    const [event] = events();
    expect(event.action).toBe('roles.grant');
    // Both flag names recorded; only the allowlisted `role` keeps its value.
    expect(event.details.args).toEqual(['role', 'user']);
    expect(event.details.role).toBe('admin');
    expect(event.details.user).toBeUndefined();
    // The user id still surfaces structurally, in resources.
    expect(event.resources).toContainEqual({ type: 'user', id: 'slack:U1' });
  });

  it('records a denied event for a scope denial, naming the attempted resource type, with no free-text reason', async () => {
    const resp = await dispatch({ id: '1', command: 'wirings-list', args: {} }, AGENT_CTX);

    expect(resp.ok).toBe(false);
    const [event] = events();
    expect(event).toMatchObject({
      action: 'wirings.list',
      outcome: 'denied',
      resources: [{ type: 'wirings' }],
      details: { args: [], error: 'forbidden' },
    });
    // The denial message (which can echo caller input) is never stored.
    expect(event.details.reason).toBeUndefined();
  });

  it('records a failure event with the error code only when the handler throws', async () => {
    await dispatch({ id: '1', command: 'groups-fail', args: {} }, { caller: 'host' });

    const [event] = events();
    expect(event).toMatchObject({ action: 'groups.fail', outcome: 'failure', details: { error: 'handler-error' } });
    expect(event.details.reason).toBeUndefined();
  });

  it('records a failure event and re-throws when the dispatcher itself throws', async () => {
    mockRequestApproval.mockRejectedValueOnce(new Error('pending_approvals insert failed'));

    await expect(dispatch({ id: '1', command: 'groups-gated', args: {} }, AGENT_CTX)).rejects.toThrow(
      'pending_approvals insert failed',
    );

    const [event] = events();
    expect(event).toMatchObject({ action: 'groups.gated', outcome: 'failure', details: { error: 'exception' } });
  });

  it('records a hold as a pending event correlated to the approval row it created', async () => {
    pendingRows.rows = [grantRow('1', 'groups-gated')];

    const resp = await dispatch({ id: '1', command: 'groups-gated', args: {} }, AGENT_CTX);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    const [event] = events();
    expect(event).toMatchObject({
      action: 'groups.gated',
      outcome: 'pending',
      correlation_id: 'appr-123-abc',
    });
    expect(event.resources).toContainEqual({ type: 'approval', id: 'appr-123-abc' });
    expect(event.details.error).toBeUndefined();
  });

  it('records an uncorrelated pending event when no approval row was created (no approver)', async () => {
    pendingRows.rows = [];

    await dispatch({ id: '1', command: 'groups-gated', args: {} }, AGENT_CTX);

    const [event] = events();
    expect(event).toMatchObject({ outcome: 'pending', correlation_id: null });
  });

  it('records an approved replay as an `approved` event with the grant approval id', async () => {
    const grant = grantRow('9', 'groups-gated');
    mockGetPendingApproval.mockReturnValue(grant);

    const resp = await dispatch({ id: '9', command: 'groups-gated', args: {} }, AGENT_CTX, { grant });

    expect(resp.ok).toBe(true);
    const [event] = events();
    expect(event).toMatchObject({
      action: 'groups.gated',
      outcome: 'approved',
      correlation_id: 'appr-123-abc',
    });
    expect(event.resources).toContainEqual({ type: 'approval', id: 'appr-123-abc' });
  });

  it('records a --help probe under a neutral cli.help action, never the real verb', async () => {
    const resp = await dispatch({ id: '1', command: 'groups-gated', args: { help: true } }, AGENT_CTX);

    expect(resp.ok).toBe(true);
    const [event] = events();
    expect(event.action).toBe('cli.help');
    expect(event.outcome).toBe('success');
    expect(event.resources).toEqual([]);
  });

  it('records unknown commands as cli.unknown-command with the raw name in details', async () => {
    await dispatch({ id: '1', command: 'nope-nothing', args: {} }, { caller: 'host' });

    const [event] = events();
    expect(event).toMatchObject({
      action: 'cli.unknown-command',
      outcome: 'failure',
      resources: [],
      details: { args: [], command: 'nope-nothing', error: 'unknown-command' },
    });
  });

  it('records the resolved command and target id for dash-joined positional ids', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    await dispatch({ id: '1', command: `groups-get-${uuid}`, args: {} }, { caller: 'host' });

    const [event] = events();
    expect(event).toMatchObject({ action: 'groups.get', outcome: 'success' });
    expect(event.resources).toContainEqual({ type: 'agent_group', id: uuid });
    // The id surfaces in resources; details keeps only the flag name.
    expect(event.details.args).toContain('id');
    expect(event.details.id).toBeUndefined();
  });

  it('normalizes hyphenated arg key names in details', async () => {
    await dispatch({ id: '1', command: 'groups-test', args: { 'dry-run': 'true' } }, { caller: 'host' });

    const [event] = events();
    expect(event.details.args).toContain('dry_run');
    expect(event.details.dry_run).toBeUndefined();
  });

  it('never stores arg values — a secret-bearing arg leaves only its key', async () => {
    await dispatch(
      { id: '1', command: 'groups-test', args: { env: '{"NOTION_TOKEN":"tok-123","SAFE":"ok"}' } },
      { caller: 'host' },
    );

    const [event] = events();
    expect(event.details.args).toContain('env');
    expect(event.details.env).toBeUndefined();
    // The secret never reaches the stored bytes.
    expect(appended.lines[0]).not.toContain('NOTION_TOKEN');
    expect(appended.lines[0]).not.toContain('tok-123');
  });
});
