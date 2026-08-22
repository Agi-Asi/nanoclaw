---
name: add-cursor
description: Use Cursor (local Agent SDK) as a full agent provider — planning, tool orchestration, MCP tools, session resume — alongside or instead of Claude. Cursor-account sign-in or API key, vault-only via OneCLI. Per-group via `ncl groups config update --provider cursor`. Distinct from using Cursor as a cloud agent (those run on Cursor VMs and are not this provider).
---

# Cursor agent provider

> Shortcut: `pnpm exec tsx setup/index.ts --step provider-auth cursor` performs this whole install (payload from the providers branch: files, barrels, SDK pin, image rebuild) plus auth in one command. The steps below are the same operations, for agent-driven or manual application.

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the Cursor provider: copy the payload from the `providers` branch, append one import to each of the three provider barrels, pin `@cursor/sdk` in the agent-runner tree, rebuild, then run the vault auth walk-through.

The provider runs `@cursor/sdk` in-process inside the container (`Agent.create` / `resume` / `send`): native streaming, MCP tools, a local agent store (the continuation is a Cursor `agentId`). Credentials are **vault-only**: OneCLI injects the real Cursor API key on the wire and the container only ever sees a placeholder `CURSOR_API_KEY` — no key in `.env`, nothing readable in the container. Cursor-account OAuth and a dashboard key entered into setup's local masked prompt create two narrowly scoped vault entries from the same handoff file: `api2.cursor.sh/auth/exchange_user_api_key` and `api.cursor.com/v1/models`. Cursor exchanges the user key at the first endpoint for a short-lived runtime token held only by the SDK. Later requests still use the configured proxy, but the exact-route vault rules do not overwrite that token. Never put a key in chat.

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Install

### Pre-flight

Check whether the payload is already wired (a prior apply, or a trunk that still carries it). All of these present means installed — skip to **Authenticate**:

- `src/providers/cursor.ts` and `src/providers/cursor-agents-md.ts`
- `container/agent-runner/src/providers/cursor.ts`, `cursor-auth.ts`, and `cursor-hook.ts`
- `setup/providers/cursor.ts`
- `import './cursor.js';` in `src/providers/index.ts`, `container/agent-runner/src/providers/index.ts`, and `setup/providers/index.ts`
- `@cursor/sdk` pinned in `container/agent-runner/package.json`

### 1. Fetch and copy the payload

Fetch the `providers` branch and copy the Cursor payload into all three trees (additive — overwrite each file, never merge the branch). The canonical remote is `nanocoai/nanoclaw` (`origin` on a normal clone; a distill fork should fetch from that upstream, not from itself). The host files are the provider contribution + AGENTS.md compose + their guards; the container files are the provider runtime (turn loop, memory sessionStart hook adapter, event mapping) + their guards; the setup file is the picker entry + vault auth walk-through; `container/AGENTS.md` is the runtime-contract base the composed AGENTS.md embeds.

```nc:copy from-branch:providers
src/providers/cursor.ts
src/providers/cursor-agents-md.ts
src/providers/cursor-registration.test.ts
src/providers/cursor-host-contribution.test.ts
src/providers/cursor-agents-md.test.ts
container/agent-runner/src/providers/cursor.ts
container/agent-runner/src/providers/cursor-auth.ts
container/agent-runner/src/providers/cursor-hook.ts
container/agent-runner/src/providers/cursor-registration.test.ts
container/agent-runner/src/providers/cursor.factory.test.ts
container/agent-runner/src/providers/cursor-auth.test.ts
container/agent-runner/src/providers/cursor-hook.test.ts
container/agent-runner/src/providers/cursor.poll-loop.test.ts
setup/providers/cursor.ts
setup/providers/cursor.test.ts
setup/providers/cursor-registration.test.ts
container/AGENTS.md
```

### 2. Wire the barrels

Append the self-registration import to each of the three provider barrels (skipped if the line is already present). Each barrel-registration test imports its real barrel and asserts `cursor` is registered — they go red the moment a barrel line is missing or drifts.

```nc:append to:src/providers/index.ts
import './cursor.js';
```
```nc:append to:container/agent-runner/src/providers/index.ts
import './cursor.js';
```
```nc:append to:setup/providers/index.ts
import './cursor.js';
```

### 3. Agent-runner dependency

The container talks to Cursor through `@cursor/sdk`, not a CLI binary. Pin the exact version in the agent-runner tree (Bun, not the host pnpm workspace — `@cursor/sdk` must not enter the host lockfile). Re-running `bun add` of the same pin is a no-op. Do not run `bun update`.

```nc:dep manager:bun cwd:container/agent-runner
@cursor/sdk@1.0.28
```

The version (`1.0.28`) is the canonical pin — this SKILL.md is the source of truth. It is the first release with the Bun stream-stall fix (≥ 1.0.23).

### 4. Build

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### 5. Validate

```nc:run effect:test
pnpm vitest run src/providers/cursor-registration.test.ts src/providers/cursor-host-contribution.test.ts src/providers/cursor-agents-md.test.ts setup/providers/cursor-registration.test.ts setup/providers/cursor.test.ts setup/provider-auth.test.ts
```
```nc:run effect:test
cd container/agent-runner && bun test src/providers/cursor-registration.test.ts src/providers/cursor.factory.test.ts src/providers/cursor-auth.test.ts src/providers/cursor-hook.test.ts src/providers/cursor.poll-loop.test.ts
```

The registration tests import only the real barrels — they go red if a barrel line is missing, a barrel fails to evaluate, or the payload is broken. The container registration test also imports `@cursor/sdk` unmocked, so a missing package goes red.

## Authenticate

```nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth cursor
```

The same walk-through fresh installs get from the setup picker: sign in with a Cursor account (browser or URL), or enter a Cursor API key into the local masked prompt. Account sign-in uses `Cursor.auth.login({ store: null })` to mint an expiring NanoClaw key, writes it directly to a mode-0600 handoff file, and asks OneCLI to consume that file. Manual keys use the same handoff. The key is never printed, placed in process arguments, or sent through chat. The flow creates generic OneCLI entries for both exact SDK routes (`api2.cursor.sh/auth/exchange_user_api_key` and `api.cursor.com/v1/models`), short-circuits only when both exist, and finishes with the install check.

OAuth-minted keys default to 90 days. Dashboard and service-account keys last until revoked. Prefer a dashboard or service-account key for unattended installs.
To replace an expired or revoked key, add `--force` to the provider-auth command. Rotation stages both replacement routes before removing the old entries, so a failed create preserves the working pair.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider cursor
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host. Every provider uses the
same `memory/` tree, so memory carries across automatically. Run
`/migrate-memory` only when upgrading a group that still has legacy `.seed.md`,
`CLAUDE.local.md`, or unindexed imported memory. See
[docs/provider-migration.md](../../docs/provider-migration.md).

### Default new groups to cursor (optional)

New groups are created on the **instance default** (`DEFAULT_AGENT_PROVIDER` in `.env`, or `claude` when unset). Installing this skill wires cursor in but does NOT change that default — "installed" is not "authenticated", so the default stays claude until you opt in explicitly.

After install, ask the operator before flipping it:

> "Cursor is installed. Default new agent groups to cursor? Existing groups keep their current provider."

On yes — set it, then restart the host so it takes effect:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key DEFAULT_AGENT_PROVIDER --value cursor
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS; Linux: systemctl --user restart nanoclaw
```

This affects only groups created afterward. Per-group `ncl groups config update --provider` still overrides the default in either direction.

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason (e.g. `Unknown provider: cursor. Registered: claude` means the barrels aren't wired in the running build).
- **401 after months of working:** an OAuth-minted user key expired (default 90 days). Run `pnpm exec tsx setup/index.ts --step provider-auth cursor --force`. Prefer a dashboard or service-account key for unattended installs.
- **Auth errors mid-conversation:** the vault secret is missing or stale — run `pnpm exec tsx setup/index.ts --step provider-auth cursor --force`.
- **`@cursor/sdk` missing inside the container:** the image predates the pin — re-run `./container/build.sh`. Do not add a Cursor CLI to `container/cli-tools.json`; the container uses the library.
