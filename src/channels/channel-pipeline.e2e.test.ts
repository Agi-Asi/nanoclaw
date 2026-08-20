/** Mocked end-to-end host channel pipeline: adapter → router → mailbox → delivery → adapter. */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, OutboundMessage } from './adapter.js';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-channel-pipeline-e2e';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-channel-pipeline-e2e',
    GROUPS_DIR: '/tmp/nanoclaw-channel-pipeline-e2e/groups',
  };
});

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { findSession } from '../db/sessions.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../delivery.js';
import { getAgentMailbox } from '../mailbox/index.js';
import { routeInbound } from '../router.js';
import {
  createChannelDeliveryAdapter,
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from './channel-registry.js';

const delivered: OutboundMessage[] = [];
const adapter: ChannelAdapter = {
  name: 'mock-e2e',
  channelType: 'mock-e2e',
  supportsThreads: false,
  async setup() {},
  async teardown() {},
  isConnected: () => true,
  async deliver(_platformId, _threadId, message) {
    delivered.push(message);
    return 'mock-platform-message';
  },
};

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  delivered.length = 0;

  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: 'ag-e2e',
    name: 'E2E Agent',
    folder: 'e2e-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createMessagingGroup({
    id: 'mg-e2e',
    channel_type: 'mock-e2e',
    platform_id: 'mock-channel',
    name: 'Mock Channel',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
  await createMessagingGroupAgent({
    id: 'mga-e2e',
    messaging_group_id: 'mg-e2e',
    agent_group_id: 'ag-e2e',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });

  registerChannelAdapter('mock-e2e', { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  setDeliveryAdapter(createChannelDeliveryAdapter());
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('mocked channel pipeline', () => {
  it('routes one inbound message through both mailboxes and delivers one reply', async () => {
    await routeInbound({
      channelType: 'mock-e2e',
      platformId: 'mock-channel',
      threadId: null,
      message: {
        id: 'mock-inbound',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hello' }),
        timestamp: new Date().toISOString(),
      },
    });

    const session = await findSession('mg-e2e', null);
    expect(session).toBeDefined();

    const key = { agentGroupId: 'ag-e2e', sessionId: session!.id };
    await getAgentMailbox().session(key, async (mailbox) => {
      await mailbox.writeDirect({
        id: 'mock-outbound',
        kind: 'chat',
        platformId: 'mock-channel',
        channelType: 'mock-e2e',
        threadId: null,
        content: JSON.stringify({ text: 'Hello back' }),
      });
    });

    await deliverSessionMessages(session!);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ kind: 'chat', content: { text: 'Hello back' } });
  });
});
