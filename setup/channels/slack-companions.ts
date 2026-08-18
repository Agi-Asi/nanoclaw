/**
 * Slack's companion-skill declaration — the rest of the Slack channel payload
 * beyond /add-slack itself. The channel install flow's companion registry
 * (setup/channels/companions.ts) applies these right after the main install
 * skill, with one deferred service restart after all of them; the install
 * skill appends the `registerCompanionSkills('slack', …)` call into that
 * registry, importing this list. Kept as a plain data module (no import of
 * the registry) so the appended registration can't create an import cycle
 * back into the registry's own initialization.
 *
 * Why the companion is part of the payload:
 *  - slack-a2a-rooms → src/channels/slack-a2a.ts. The room admission policy
 *    (SLACK_A2A_ROOMS allowlist, hop limits, slack:bot:<id> re-attribution)
 *    registered onto the channel guard's seam. Without it, shared rooms open
 *    but bot-authored inbound stays dropped by the guard's default policy,
 *    so sibling bots never hear each other.
 *
 * Deliberately NOT listed: slack-multi-instance. The SLACK_INSTANCES
 * registration loop is native to the adapter (src/channels/slack.ts reads
 * SLACK_INSTANCES at import and registers a `slack-<name>` instance per
 * entry), so that skill is documentation-only — the env-key format for
 * per-instance tokens — with no directives for the companion flow to apply.
 */
export const SLACK_COMPANION_SKILLS = ['slack-a2a-rooms'] as const;
