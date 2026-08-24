---
name: add-mattermost
description: Add a self-hosted or cloud Mattermost bot channel through the Chat SDK bridge.
---

# Add Mattermost Channel

Adds Mattermost DMs, channels, threads, files, reactions, and interactive
approval cards. Messages arrive over Mattermost's WebSocket; card clicks return
to NanoClaw over an authenticated HTTP callback. Every step is safe to re-run.

## Apply

### 1. Copy and register the channel

Copy the canonical adapter and registration test from the `channels` branch.

```nc:copy from-branch:channels
src/channels/mattermost.ts
src/channels/mattermost-registration.test.ts
```

Append the channel's single reach-in to the barrel, skipping it if present.

```nc:append to:src/channels/index.ts
import './mattermost.js';
```

Remove the conflicting unscoped adapter when it is installed. The channel uses
only NanoCo's scoped package.

```nc:run
if node -e "const p=require('./package.json'); process.exit(p.dependencies?.['chat-adapter-mattermost'] ? 0 : 1)"; then pnpm remove chat-adapter-mattermost; fi
```

Install NanoCo's audited adapter at the exact supported version.

```nc:dep
@nanoco/chat-adapter-mattermost@0.1.0
```

### 2. Create and authenticate the bot

Tell the operator:

```nc:operator
Create a dedicated Mattermost bot:
1. As a System Admin, open System Console → Integrations → Bot Accounts and enable bot-account creation.
2. Create a bot such as `nanoclaw`, then copy the access token shown after creation.
3. Add the bot to every team and channel where it should receive messages. Bots do not join channels automatically.
4. Keep the token private. If it is lost, create a new token and deactivate the obsolete one after replacement.
```

Collect the server URL without a trailing slash and the bot token.

```nc:prompt base_url normalize:rstrip-slash validate:^https?://.+
Mattermost base URL including the scheme, such as `https://mattermost.example.com`.
```

```nc:prompt bot_token secret normalize:trim validate:^[A-Za-z0-9_-]{20,}$
Mattermost bot access token (20 or more letters, digits, underscores, or hyphens).
```

Confirm the credential and capture the bot identity. A failure means the URL,
token, or bot-account status is wrong.

```nc:run capture:bot_user_id=.id,bot_username=.username effect:fetch
curl -sf "{{base_url}}/api/v4/users/me" -H "Authorization: Bearer {{bot_token}}"
```

### 3. Configure authenticated card callbacks

Approvals require Mattermost itself—not the browser—to reach NanoClaw. Ask for
a URL routable from the Mattermost server. It may be NanoClaw's base URL or the
full `/webhook/mattermost` route; the adapter normalizes either form.

```nc:prompt callback_url normalize:rstrip-slash validate:^https?://.+
Callback URL reachable from Mattermost, such as `https://nanoclaw.example.com` or `http://host.docker.internal:3000/webhook/mattermost`.
```

Mattermost does not sign action callbacks. Generate a random shared secret for
the server-only callback context.

```nc:run capture:callback_secret effect:external validate:^[a-f0-9]{64}$
openssl rand -hex 32
```

Store the channel configuration. Existing keys remain unchanged on a re-run.

```nc:env-set
MATTERMOST_BASE_URL={{base_url}}
MATTERMOST_BOT_TOKEN={{bot_token}}
MATTERMOST_CALLBACK_URL={{callback_url}}
MATTERMOST_CALLBACK_SECRET={{callback_secret}}
```

Tell the operator:

```nc:operator
From the Mattermost server, verify the callback host is reachable. For a private host or Docker bridge name, add that hostname or IP under System Console → Environment → Developer → Allow untrusted internal connections. Use a publicly trusted HTTPS certificate in production.
```

### 4. Resolve the owner's DM

Ask for the Mattermost username that will own this NanoClaw installation.

```nc:prompt owner_username normalize:lower validate:^[a-z0-9][a-z0-9._-]{0,63}$
Your Mattermost username, without `@`.
```

Resolve that user and open the DM shared with the bot.

```nc:run capture:owner_user_id=.id effect:fetch
curl -sf "{{base_url}}/api/v4/users/username/{{owner_username}}" -H "Authorization: Bearer {{bot_token}}"
```

```nc:run capture:platform_id effect:fetch validate:^mattermost:[a-z0-9]{26}$
curl -sf -X POST "{{base_url}}/api/v4/channels/direct" -H "Authorization: Bearer {{bot_token}}" -H "Content-Type: application/json" -d '["{{owner_user_id}}","{{bot_user_id}}"]' | jq -er '"mattermost:" + .id'
```

The resolved `platform_id` and `owner_username` are used by
`/init-first-agent`. If an owner exists, use `/manage-channels` instead.

### 5. Build, test, and restart

Build the composed host to guard the typed Chat SDK bridge call and dependency.

```nc:run effect:build
pnpm run build
```

Run the registration test through the real channel barrel.

```nc:run effect:test
pnpm exec vitest run src/channels/mattermost-registration.test.ts
```

Restart NanoClaw so the channel and credentials load.

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Next steps

For a first channel, continue with `/init-first-agent` using `mattermost`,
`{{platform_id}}`, and `{{owner_username}}`. Otherwise run `/manage-channels`.

Send the bot a DM and mention it in a joined channel. The first mention in an
unwired channel sends an approval card to the owner's bot DM. Approve it there;
NanoClaw replays the held message after creating the wiring.

Click a real approval card to verify callbacks. Success replaces the buttons
with the chosen result. An unsigned probe must return `401`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  http://<nanoclaw-host>:3000/webhook/mattermost
```

## Channel information

- **type:** `mattermost`
- **platform ID:** `mattermost:<channel-id>` for channels and DMs
- **threads:** channel posts use optional Mattermost reply roots
- **group trigger:** mention-sticky, scoped per thread
- **DM trigger:** every message
- **unknown channels:** request owner approval
- **transport:** WebSocket inbound, REST outbound, HTTP action callbacks

## Troubleshooting

**The token check returns 401.** The token is stale, belongs to a deactivated
bot, or was pasted incorrectly. Create a replacement token and deactivate the
old token after the replacement works.

**The bot ignores a channel.** Add it to that team and channel. Membership
changes are observed, but restarting NanoClaw forces a fresh subscription.

**A new channel gets no immediate reply.** Check the owner's DM with the bot.
NanoClaw holds the first message behind a channel-approval card and deduplicates
later mentions until that card is resolved.

**Cards render but clicks do nothing.** From the Mattermost server, POST to the
callback URL. A `401` proves the path reaches NanoClaw; timeout or refusal means
routing or firewall failure. Mattermost logs report blocked hosts and TLS errors.

**The adapter repeatedly reconnects.** Confirm `/api/v4/websocket` supports
WebSocket upgrades through every reverse proxy and that idle connections live
longer than the adapter heartbeat.

**Messages arrive but no agent runs.** Inspect `ncl dropped-messages list` and
`ncl wirings list`. `no_agent_wired` means approval is pending or no wiring was
created; it is not an adapter failure.
