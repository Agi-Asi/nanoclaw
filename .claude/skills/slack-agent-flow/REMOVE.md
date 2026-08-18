# Remove slack-agent-flow

Reverses everything Apply added. Runtime data the flow created (agent groups,
messaging groups, wirings, `.env` token/instance/room lines, provisioned Slack
apps) is user data and is deliberately left alone — for per-agent teardown of
a provisioned bot, follow the slack-managed-agents skill's teardown section.

1. Delete the barrel registration lines (delete, don't comment out):
   - `import './slack-agent-flow/index.js';` from `src/modules/index.ts`
   - `import './rooms.js';` from `container/agent-runner/src/mcp-tools/index.ts`

2. Delete the copied payload files:

   ```bash
   rm -rf src/modules/slack-agent-flow
   rm -f scripts/slack-agent-flow-finish.ts
   rm -f container/agent-runner/src/mcp-tools/rooms.ts \
         container/agent-runner/src/mcp-tools/rooms.test.ts \
         container/agent-runner/src/mcp-tools/rooms.instructions.md \
         container/agent-runner/src/mcp-tools/create-agent-slack.instructions.md
   rm -rf container/skills/slack-construct-agents
   rm -f container/skills/welcome/addenda/teams-tour.md
   ```

3. Rebuild and restart:

   ```bash
   pnpm run build
   bash setup/lib/restart.sh
   ```

Composed group CLAUDE.md files regenerate on the next container spawn, so the
dropped instructions fragment and welcome addendum disappear from agents
without any manual cleanup.
