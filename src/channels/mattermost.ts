/**
 * Mattermost channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Wraps the community `chat-adapter-mattermost` package. Mattermost, like
 * Slack, models replies as optional threads within a channel (a thread id
 * with no root post is the channel itself; a thread id with a root post is
 * a specific reply-thread) — so this follows the Slack shape, not
 * Telegram's channel-is-the-only-conversation model.
 */
import { createMattermostAdapter } from 'chat-adapter-mattermost';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot account on a threaded platform. group threads:true keeps
 * mention-sticky bounded — engagement sticks per-thread, not forever.
 * dm.threads:false mirrors Slack's policy: DM sub-threads collapse into the
 * one DM session unless a wiring overrides it.
 */
const MATTERMOST_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

registerChannelAdapter('mattermost', {
  factory: () => {
    const env = readEnvFile(['MATTERMOST_BASE_URL', 'MATTERMOST_BOT_TOKEN']);
    if (!env.MATTERMOST_BASE_URL || !env.MATTERMOST_BOT_TOKEN) return null;

    const mattermostAdapter = createMattermostAdapter({
      baseUrl: env.MATTERMOST_BASE_URL,
      botToken: env.MATTERMOST_BOT_TOKEN,
    });

    const bridge = createChatSdkBridge({
      adapter: mattermostAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: MATTERMOST_DEFAULTS,
    });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await mattermostAdapter.fetchThread(platformId);
        return info.channelName ?? null;
      } catch {
        return null;
      }
    };
    return bridge;
  },
  defaults: MATTERMOST_DEFAULTS,
});
