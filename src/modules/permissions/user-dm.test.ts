import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import type { ChannelAdapter } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { log } from '../../log.js';
import { createUser } from './db/users.js';
import { upsertUserDm } from './db/user-dms.js';
import { ensureUserDm } from './user-dm.js';

function now(): string {
  return new Date().toISOString();
}

function seedUser(id: string, kind: string): void {
  createUser({ id, kind, display_name: null, created_at: now() });
}

function registerTestAdapter(channelType: string, openDM?: (handle: string) => Promise<string>): void {
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return undefined;
    },
  };
  if (openDM) adapter.openDM = openDM;
  registerChannelAdapter(channelType, { factory: () => adapter });
}

async function startRegisteredAdapters(): Promise<void> {
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  const db = initTestDb();
  runMigrations(db);
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
});

describe('ensureUserDm privacy-safe logging', () => {
  it('always omits identities, messaging-group ids, and SDK errors', async () => {
    registerTestAdapter('privacy-error', async () => {
      throw new Error('private-sdk-error-sentinel');
    });
    registerTestAdapter('privacy-direct');
    await startRegisteredAdapters();

    seedUser('privacy-error:private-handle-sentinel', 'privacy-error');
    seedUser('privacy-direct:stale-handle-sentinel', 'privacy-direct');
    seedUser('invalid-user-private-sentinel', 'invalid-kind');

    createMessagingGroup({
      id: 'messaging-group-private-sentinel',
      channel_type: 'privacy-direct',
      platform_id: 'old-platform-private-sentinel',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    upsertUserDm({
      user_id: 'privacy-direct:stale-handle-sentinel',
      channel_type: 'privacy-direct',
      messaging_group_id: 'messaging-group-private-sentinel',
      resolved_at: now(),
    });
    getDb().pragma('foreign_keys = OFF');
    getDb().prepare("DELETE FROM messaging_groups WHERE id = 'messaging-group-private-sentinel'").run();
    getDb().pragma('foreign_keys = ON');

    await expect(ensureUserDm('unknown-user-private-sentinel')).resolves.toBeNull();
    await expect(ensureUserDm('invalid-user-private-sentinel')).resolves.toBeNull();
    await expect(ensureUserDm('privacy-error:private-handle-sentinel')).resolves.toBeNull();
    await expect(ensureUserDm('privacy-direct:stale-handle-sentinel')).resolves.toBeDefined();

    expect(log.error).toHaveBeenCalledWith('ensureUserDm: adapter.openDM failed', {
      channelType: 'privacy-error',
    });
    expect(log.warn).toHaveBeenCalledWith('ensureUserDm: user not found');
    expect(log.warn).toHaveBeenCalledWith('ensureUserDm: user id not namespaced');
    expect(log.warn).toHaveBeenCalledWith('ensureUserDm: cached row references missing messaging_group, re-resolving', {
      channelType: 'privacy-direct',
    });
    expect(log.info).toHaveBeenCalledWith('ensureUserDm: created DM messaging_group', {
      channelType: 'privacy-direct',
    });

    const serializedLogs = JSON.stringify({
      info: vi.mocked(log.info).mock.calls,
      warn: vi.mocked(log.warn).mock.calls,
      error: vi.mocked(log.error).mock.calls,
    });
    for (const sentinel of [
      'unknown-user-private-sentinel',
      'invalid-user-private-sentinel',
      'private-handle-sentinel',
      'stale-handle-sentinel',
      'messaging-group-private-sentinel',
      'old-platform-private-sentinel',
      'private-sdk-error-sentinel',
    ]) {
      expect(serializedLogs).not.toContain(sentinel);
    }
  });
});
