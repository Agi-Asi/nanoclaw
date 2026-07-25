/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 *
 * Model and endpoint selection is PER GROUP, so two opencode groups can run
 * different models against different local servers. Precedence, highest first:
 *
 *   1. `<groupDir>/provider-env.json` — allowlisted env overrides, for pointing
 *      one group at its own vLLM endpoint / context limits.
 *   2. `<groupDir>/container.json` `model` — the group's configured model
 *      (`ncl`-settable), mapped onto OPENCODE_MODEL.
 *   3. host env — the service-wide default, applied by the passthrough loop.
 *
 * Both files are optional: with neither present the contribution behaves
 * exactly as it did before, i.e. host env only. Neither a missing file nor a
 * malformed one is fatal — they warn and are ignored.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/**
 * Env keys a group is allowed to override via `provider-env.json`. Deliberately
 * narrow: model identity, the endpoint it lives behind, and the capability hints
 * OpenCode needs for a custom model. OPENCODE_PROVIDER is NOT overridable — the
 * provider name is the routing key the host already resolved to get here, and a
 * group flipping it would desync the container's transport wiring.
 */
const GROUP_ENV_ALLOWLIST = [
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'ANTHROPIC_BASE_URL',
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
  'OPENCODE_MODEL_INPUT_MODALITIES',
] as const;

/** Read a JSON file, returning undefined for "absent" and for "unusable". Never throws. */
function readJsonIfPresent(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (err) {
    log.warn('opencode: ignoring unreadable JSON', { path: filePath, err });
    return undefined;
  }
}

/**
 * Layer the group's own model/endpoint choices over `env` (which already carries
 * the host-env passthrough). Mutates `env` in place; see the precedence note in
 * the file header. Exported for tests — the spawn path goes through the
 * registered contribution below.
 */
export function applyGroupEnvOverrides(env: Record<string, string>, groupDir: string): void {
  const model = (readJsonIfPresent(path.join(groupDir, 'container.json')) as { model?: unknown } | undefined)?.model;
  if (typeof model === 'string' && model.trim()) env.OPENCODE_MODEL = model;

  const providerEnvPath = path.join(groupDir, 'provider-env.json');
  const providerEnv = readJsonIfPresent(providerEnvPath);
  if (providerEnv === undefined) return;
  if (typeof providerEnv !== 'object' || providerEnv === null || Array.isArray(providerEnv)) {
    log.warn('opencode: provider-env.json is not a JSON object, ignoring', { path: providerEnvPath });
    return;
  }

  for (const [key, value] of Object.entries(providerEnv as Record<string, unknown>)) {
    if (!(GROUP_ENV_ALLOWLIST as readonly string[]).includes(key)) {
      log.warn('opencode: provider-env.json key is not on the allowlist, skipping', { path: providerEnvPath, key });
      continue;
    }
    if (typeof value !== 'string') {
      log.warn('opencode: provider-env.json value is not a string, skipping', { path: providerEnvPath, key });
      continue;
    }
    env[key] = value;
  }
}

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  for (const key of [
    'OPENCODE_PROVIDER',
    'OPENCODE_MODEL',
    'OPENCODE_SMALL_MODEL',
    'ANTHROPIC_BASE_URL',
    'OPENCODE_MODEL_CONTEXT_LIMIT',
    'OPENCODE_MODEL_OUTPUT_LIMIT',
    'OPENCODE_MODEL_INPUT_MODALITIES',
  ] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  // Group overrides land on top of the host-env defaults. The container context
  // carries no group directory, so resolve it the way the runner does — from the
  // group's folder under GROUPS_DIR. (Swap this for `ctx.groupDir` once the
  // registry context grows the field.)
  const group = getAgentGroup(ctx.agentGroupId);
  if (group) applyGroupEnvOverrides(env, path.resolve(GROUPS_DIR, group.folder));

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
