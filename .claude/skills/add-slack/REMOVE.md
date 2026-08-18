# Remove Slack

Every step is idempotent — safe to re-run.

## 1. Remove the registrations

Delete the appended lines (skip any already gone):

- `src/channels/index.ts`: `import './slack.js';` and `import './slack-a2a-guard.js';`
- `src/modules/index.ts`: `import './slack-room-membership/index.js';`,
  `import './canvas-actions/index.js';`, `import './slack-onboarding/index.js';`
- `container/agent-runner/src/mcp-tools/index.ts`: `import './canvas.js';`
- `setup/channels/companions.ts`: `import { SLACK_COMPANION_SKILLS } from './slack-companions.js';`
  and `registerCompanionSkills('slack', SLACK_COMPANION_SKILLS);`

## 2. Remove the payload files

```bash
rm -f src/channels/slack.ts src/channels/slack-lib.ts src/channels/slack-lib.test.ts \
  src/channels/slack-a2a-guard.ts src/channels/slack-a2a-guard.test.ts \
  src/channels/slack-registration.test.ts \
  src/channels/slack-instances-registration.test.ts \
  src/env-file.ts src/env-file.test.ts \
  container/agent-runner/src/mcp-tools/canvas.ts \
  container/agent-runner/src/mcp-tools/canvas.instructions.md \
  container/agent-runner/src/mcp-tools/canvas.test.ts \
  container/skills/slack-formatting/SKILL.md \
  container/skills/welcome/addenda/slack.md \
  setup/channels/slack-companions.ts
rm -rf src/modules/slack-room-membership src/modules/canvas-actions \
  src/modules/slack-onboarding container/skills/canvas-work \
  container/skills/slack-construct
```

Caution: `src/env-file.ts` is shared plumbing — leave it in place if another
installed skill (e.g. the agent-provisioning flow) still imports it.

## 3. Remove credentials

Remove `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET` from
`.env` (each is present only if its delivery mode was configured). If named
instances were configured, also remove `SLACK_INSTANCES` and every suffixed
`SLACK_BOT_TOKEN_<NAME>` / `SLACK_APP_TOKEN_<NAME>` /
`SLACK_SIGNING_SECRET_<NAME>` line.

## 4. Remove the package

```bash
pnpm uninstall @chat-adapter/slack
```

## 5. Companion skills

If the companion skill was applied, remove it too (its own REMOVE.md):
`slack-a2a-rooms`.

## 6. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
