/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Socket Mode opt-in: set SLACK_APP_TOKEN (xapp-…) to receive events over an
 * outbound WebSocket instead of an inbound HTTPS webhook.
 *
 * Additional bot identities in the same workspace reuse createSlackBridge
 * with suffixed env keys and an instance key (see the slack-multi-instance
 * skill) — same construction path as the default app, no mirrored factory.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import type { ChannelAdapter, ChannelContextDefaults, ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. group threads:true keeps
 * mention-sticky bounded — engagement sticks per-thread, not forever.
 * dm.threads:false is a deliberate policy choice, not a capability limit:
 * Slack users can open sub-threads inside a DM, but by default the agent
 * replies top-level and all DM sub-threads collapse into the one DM session.
 * This declaration owns that judgment (it used to be hardcoded router
 * behavior); operators who want in-thread DM replies override per wiring
 * with `--threads true`.
 *
 * Agent-DM anchors (the settled Slack DM shape) — creation-time stamps, so
 * they apply to wirings/rows created from this declaration onward and never
 * flip existing installs:
 * - dm.sessionMode 'per-thread': Slack's agent-mode DM surface materializes
 *   a thread per conversation, so a new DM wiring roots a session per thread.
 *   resolveWiringDefaults derives the threads=1 stamp from this at creation
 *   (per-thread sessions structurally require honored thread ids — no
 *   separate field to declare). The live inherit value dm.threads stays
 *   false, so wirings created earlier (threads column NULL) keep collapsing
 *   DM sub-threads into the one DM session.
 * - dm.unknownSenderPolicy 'decline_notify': an unknown DM sender gets a
 *   polite decline and the owner a one-line FYI — no approval card; access
 *   grants stay explicit (`ncl members add`). A deliberate, reviewed default
 *   change for Slack DM rows auto-created after this lands.
 */
export const SLACK_DEFAULTS: ChannelDefaults = {
  dm: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: false,
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'decline_notify',
  },
  group: {
    engageMode: 'mention-sticky',
    threads: true,
    // D29: group conversations are per-thread too — Slack channels
    // materialize a thread per top-level message, and ambient context
    // (same-mg fan + channel-timeline backfill) is the continuity layer.
    // Creation-time stamp like dm.sessionMode; existing wirings never flip.
    // Canvas-comment shadow channels deliberately stay shared (wired
    // explicitly in room-canvas, the documented D29 exception).
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'request_approval',
  },
  mentions: 'platform',
};

/** Construction knobs for one Slack bot identity. */
export interface SlackBridgeOptions {
  /**
   * Uppercased/underscored instance suffix appended to each token env key
   * after an underscore — 'ALPHA' reads SLACK_BOT_TOKEN_ALPHA /
   * SLACK_SIGNING_SECRET_ALPHA / SLACK_APP_TOKEN_ALPHA. Omit (or pass '')
   * for the default app's unsuffixed keys.
   */
  envKeySuffix?: string;
  /**
   * Registry/bridge instance key (e.g. 'slack-alpha'). Omit for the default
   * instance, keyed by channelType. channelType stays 'slack' either way —
   * instance is a host-side routing key only, so user ids, formatting,
   * container config, and the wiring-defaults declaration are shared with
   * the default Slack app.
   */
  instanceKey?: string;
}

/**
 * Build one Slack bot identity's bridge from its token set. The default app
 * is the zero-suffix call (used by the registration below); named instances
 * pass a suffix + instance key and get the exact same construction — Socket
 * Mode opt-in, channel-name resolution, SLACK_DEFAULTS declaration. Returns
 * null when the bot token is missing so the registry surfaces its normal
 * "credentials missing, skipping" warning.
 */
export function createSlackBridge(options: SlackBridgeOptions = {}): ChannelAdapter | null {
  const suffix = options.envKeySuffix ? `_${options.envKeySuffix}` : '';
  const keys = {
    botToken: `SLACK_BOT_TOKEN${suffix}`,
    signingSecret: `SLACK_SIGNING_SECRET${suffix}`,
    appToken: `SLACK_APP_TOKEN${suffix}`,
  };
  const env = readEnvFile([keys.botToken, keys.signingSecret, keys.appToken]);
  const botToken = env[keys.botToken];
  if (!botToken) return null;
  // An xapp-… token enables Socket Mode: events arrive over an outbound
  // WebSocket, so no public HTTPS endpoint is required. When set, the
  // signing secret is optional (Slack signs socket frames separately).
  const appToken = env[keys.appToken];
  const slackAdapter = createSlackAdapter({
    botToken,
    signingSecret: env[keys.signingSecret],
    appToken,
    mode: appToken ? 'socket' : 'webhook',
  });
  const bridge = createChatSdkBridge({
    adapter: slackAdapter,
    instance: options.instanceKey, // undefined ⇒ default instance (keyed by channelType)
    concurrency: 'concurrent',
    supportsThreads: true,
    defaults: SLACK_DEFAULTS,
  });
  bridge.resolveChannelName = async (platformId: string) => {
    try {
      const info = await slackAdapter.fetchThread(platformId);
      return (info as { channelName?: string }).channelName ?? null;
    } catch {
      return null;
    }
  };
  return bridge;
}

registerChannelAdapter('slack', {
  factory: () => createSlackBridge(),
  defaults: SLACK_DEFAULTS,
});
