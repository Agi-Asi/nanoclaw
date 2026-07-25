/**
 * Per-group model/endpoint selection for the opencode HOST contribution.
 *
 * Two layers are covered, deliberately:
 *   - `applyGroupEnvOverrides` directly, for the file-shape edge cases (missing
 *     files, malformed JSON, junk keys, non-string values) — cheap and exact.
 *   - the REAL registered contribution, driven through the registry against a
 *     test DB and a temp GROUPS_DIR, so the group-directory resolution and the
 *     ordering against the host-env passthrough are exercised end to end.
 *
 * This file imports ./opencode.js directly rather than the provider barrel:
 * the barrel is guarded by opencode-registration.test.ts, and going through it
 * here would couple these assertions to every other provider's import graph.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-opencode-group-env-test';
const DATA_DIR = path.join(TEST_ROOT, 'data');
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-opencode-group-env-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-opencode-group-env-test/groups',
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { applyGroupEnvOverrides } from './opencode.js'; // self-registers the provider
import { getProviderContainerConfig } from './provider-container-registry.js';
import type { AgentGroup } from '../types.js';

function writeGroupFile(folder: string, name: string, contents: string): string {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), contents);
  return dir;
}

describe('applyGroupEnvOverrides', () => {
  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("leaves env untouched when the group has neither file — today's behavior", () => {
    const groupDir = path.join(GROUPS_DIR, 'bare');
    fs.mkdirSync(groupDir, { recursive: true });
    const env = { OPENCODE_MODEL: 'service/default', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8000/v1' };

    applyGroupEnvOverrides(env, groupDir);

    expect(env).toEqual({ OPENCODE_MODEL: 'service/default', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8000/v1' });
  });

  it("maps container.json's model onto OPENCODE_MODEL, beating the host-env value", () => {
    const groupDir = writeGroupFile(
      'modelled',
      'container.json',
      JSON.stringify({ provider: 'opencode', model: 'qwen3-coder' }),
    );
    const env = { OPENCODE_MODEL: 'service/default' };

    applyGroupEnvOverrides(env, groupDir);

    expect(env.OPENCODE_MODEL).toBe('qwen3-coder');
  });

  it('ignores a container.json without a usable model string', () => {
    const groupDir = writeGroupFile('unusable', 'container.json', JSON.stringify({ model: '   ', skills: 'all' }));
    const env = { OPENCODE_MODEL: 'service/default' };

    applyGroupEnvOverrides(env, groupDir);

    expect(env.OPENCODE_MODEL).toBe('service/default');
  });

  it('lets provider-env.json beat both container.json and the host-env value', () => {
    writeGroupFile('overridden', 'container.json', JSON.stringify({ model: 'group-model' }));
    const groupDir = writeGroupFile(
      'overridden',
      'provider-env.json',
      JSON.stringify({
        OPENCODE_MODEL: 'endpoint-model',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9001/v1',
        OPENCODE_MODEL_CONTEXT_LIMIT: '32768',
      }),
    );
    const env = { OPENCODE_MODEL: 'service/default', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8000/v1' };

    applyGroupEnvOverrides(env, groupDir);

    expect(env).toEqual({
      OPENCODE_MODEL: 'endpoint-model',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9001/v1',
      OPENCODE_MODEL_CONTEXT_LIMIT: '32768',
    });
  });

  it('skips non-allowlisted keys and non-string values, keeping the good ones', () => {
    const groupDir = writeGroupFile(
      'junky',
      'provider-env.json',
      JSON.stringify({
        OPENCODE_SMALL_MODEL: 'small-model',
        OPENCODE_PROVIDER: 'anthropic', // routing key — not group-overridable
        PATH: '/evil/bin',
        AWS_SECRET_ACCESS_KEY: 'nope',
        OPENCODE_MODEL_OUTPUT_LIMIT: 4096, // number, not string
      }),
    );
    const env: Record<string, string> = { OPENCODE_PROVIDER: 'opencode' };

    applyGroupEnvOverrides(env, groupDir);

    expect(env).toEqual({ OPENCODE_PROVIDER: 'opencode', OPENCODE_SMALL_MODEL: 'small-model' });
  });

  it('warns and ignores malformed JSON rather than throwing', () => {
    writeGroupFile('broken', 'container.json', '{ not json');
    const groupDir = writeGroupFile('broken', 'provider-env.json', ']]]');
    const env = { OPENCODE_MODEL: 'service/default' };

    expect(() => applyGroupEnvOverrides(env, groupDir)).not.toThrow();
    expect(env.OPENCODE_MODEL).toBe('service/default');
  });
});

describe('opencode contribution env precedence', () => {
  const group: AgentGroup = {
    id: 'ag-opencode',
    name: 'opencode-group',
    folder: 'opencode-group',
    agent_provider: 'opencode',
    created_at: new Date().toISOString(),
  } as AgentGroup;

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
    runMigrations(initTestDb());
    createAgentGroup(group);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  function contribute(hostEnv: NodeJS.ProcessEnv) {
    const fn = getProviderContainerConfig('opencode');
    expect(fn).toBeDefined();
    return fn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', group.id, 'session-1'),
      agentGroupId: group.id,
      hostEnv,
    });
  }

  it('falls back to host env when the group configures nothing', () => {
    fs.mkdirSync(path.join(GROUPS_DIR, group.folder), { recursive: true });

    const { env } = contribute({ OPENCODE_PROVIDER: 'opencode', OPENCODE_MODEL: 'service/default' });

    expect(env?.OPENCODE_PROVIDER).toBe('opencode');
    expect(env?.OPENCODE_MODEL).toBe('service/default');
  });

  it('prefers the group model, then provider-env.json, over host env', () => {
    writeGroupFile(group.folder, 'container.json', JSON.stringify({ provider: 'opencode', model: 'group-model' }));

    const groupOnly = contribute({ OPENCODE_MODEL: 'service/default' });
    expect(groupOnly.env?.OPENCODE_MODEL).toBe('group-model');

    writeGroupFile(
      group.folder,
      'provider-env.json',
      JSON.stringify({ OPENCODE_MODEL: 'endpoint-model', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9001/v1' }),
    );

    const { env } = contribute({ OPENCODE_MODEL: 'service/default', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8000/v1' });
    expect(env?.OPENCODE_MODEL).toBe('endpoint-model');
    expect(env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9001/v1');
  });
});
