import { describe, it, expect, afterEach } from 'bun:test';

import { buildOpenCodeConfig } from './opencode.js';

const ENV_KEYS = ['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL', 'ANTHROPIC_BASE_URL'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('buildOpenCodeConfig provider transport', () => {
  it('anthropic provider gets no provider options', () => {
    process.env.OPENCODE_PROVIDER = 'anthropic';
    delete process.env.ANTHROPIC_BASE_URL;
    const config = buildOpenCodeConfig({});
    expect(config.provider).toEqual({});
  });

  it('custom base URL pins the Chat Completions transport', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/some/local-model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
    const config = buildOpenCodeConfig({});
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    expect(entry.npm).toBe('@ai-sdk/openai-compatible');
    expect(entry.options).toEqual({ apiKey: 'placeholder', baseURL: 'https://inference.example.test/v1' });
  });

  it('no base URL leaves the provider default transport', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/gpt-5.2';
    delete process.env.ANTHROPIC_BASE_URL;
    const config = buildOpenCodeConfig({});
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    expect(entry.npm).toBeUndefined();
  });
});

describe('buildOpenCodeConfig instructions', () => {
  it('loads the two always-loaded memory files for parity with Claude', () => {
    const config = buildOpenCodeConfig({});
    expect(config.instructions).toContain('/workspace/agent/memory/index.md');
    expect(config.instructions).toContain('/workspace/agent/memory/system/definition.md');
  });
});
