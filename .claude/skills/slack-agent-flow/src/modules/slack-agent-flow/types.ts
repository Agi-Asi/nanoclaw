/**
 * slack-agent-flow shared types.
 * Congruence: env-key shapes mirror the adapter's native SLACK_INSTANCES
 * conventions (src/channels/slack.ts, instanceEnvKeySuffix);
 * broker protocol mirrors src/provisioning/slack-app.ts and
 * .claude/skills/slack-managed-agents/scripts/slack-create-agent.ts. Pinned by
 * provision.congruence.test.ts.
 */

export type SlackFlowStep =
  | 'operator-identity'
  | 'origin-auth'
  | 'no-credentials'
  | 'broker'
  | 'direct-create'
  | 'env-write'
  | 'adapter-start'
  | 'dm-open'
  | 'dm-wire'
  | 'mpim-open'
  | 'a2a-env'
  | 'room-wire'
  | 'intro-post'
  /** room-actions module — create_room / add_to_room participant resolution. */
  | 'room-resolve'
  /** slack-room-membership module — join/left handling, not a create_agent flow step. */
  | 'membership';

/** Typed failure for the Slack leg. `message` MUST never contain a token value. */
export class SlackFlowError extends Error {
  constructor(
    readonly step: SlackFlowStep,
    message: string,
  ) {
    super(message);
    this.name = 'SlackFlowError';
  }
}

export interface ProvisionInput {
  /** Instance slug: output of normalizeName(), post-dedupe. */
  slug: string;
  /** Display name for the Slack app/bot (the raw agent name). */
  displayName: string;
  /** Repo root; .env lives at `${rootDir}/.env`. */
  rootDir: string;
  /** Slack workspace the app is provisioned into (broker mode requires it). */
  teamId?: string;
  /** Agent description/instructions — drives the broker's generated avatar. */
  description?: string;
  /**
   * true → plain manifest variant (no agent_view): workspace guests are
   * hard-blocked from agent-enabled apps. Default false → agent mode, the
   * default variant — a one-way door decided at provision time.
   */
  allowGuests?: boolean;
}

export interface ProvisionResult {
  slug: string;
  /** slug.toUpperCase().replace(/-/g, '_') — the .env key suffix. */
  envSuffix: string;
  botToken: string; // xoxb-… NEVER log
  appToken: string; // xapp-… NEVER log
  appId: string;
  /** True when tokens were already in .env and no provisioning call was made. */
  reused: boolean;
}

export interface OrchestrateSuccess {
  slug: string;
  newBotUserId: string;
  operatorUserId: string;
  dmChannelId: string;
  /** Absent when the create ran with room:'none' — no shared room. */
  roomChannelId?: string;
}
