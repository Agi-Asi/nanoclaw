import { describe, it, expect, afterEach } from 'bun:test';

import { buildOpenCodeConfig } from './opencode.js';

const ENV_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'ANTHROPIC_BASE_URL',
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
] as const;
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

describe('buildOpenCodeConfig model limit', () => {
  it('declares limit.context/output on the registered model when both env vars are set', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/some/local-model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
    process.env.OPENCODE_MODEL_CONTEXT_LIMIT = '65536';
    process.env.OPENCODE_MODEL_OUTPUT_LIMIT = '8192';
    const config = buildOpenCodeConfig({});
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    const models = entry.models as Record<string, Record<string, unknown>>;
    expect(models['some/local-model'].limit).toEqual({ context: 65536, output: 8192 });
  });

  it('omits limit when the env vars are unset', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/some/local-model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
    delete process.env.OPENCODE_MODEL_CONTEXT_LIMIT;
    delete process.env.OPENCODE_MODEL_OUTPUT_LIMIT;
    const config = buildOpenCodeConfig({});
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    const models = entry.models as Record<string, Record<string, unknown>>;
    expect(models['some/local-model'].limit).toBeUndefined();
  });
});

describe('buildOpenCodeConfig instructions', () => {
  it('loads the two always-loaded memory files for parity with Claude', () => {
    const config = buildOpenCodeConfig({});
    expect(config.instructions).toContain('/workspace/agent/memory/index.md');
    expect(config.instructions).toContain('/workspace/agent/memory/system/definition.md');
  });
});

describe('buildOpenCodeConfig permission', () => {
  it('pins `question` to deny deterministically instead of a wildcard string', () => {
    const config = buildOpenCodeConfig({});
    // A flat 'allow' string previously left `question` to OpenCode's own
    // resolution, which produced contradictory rules (question -> deny *
    // AND question -> allow * for the same session, observed live). An
    // explicit object with one value per category can never produce that:
    // there is exactly one entry for `question`, and it is not 'allow'.
    expect(typeof config.permission).toBe('object');
    expect(config.permission).not.toBe('allow');
    const permission = config.permission as Record<string, unknown>;
    expect(permission.question).toBe('deny');
  });

  it('keeps every other known permission category on allow (no capability regression)', () => {
    const config = buildOpenCodeConfig({});
    const permission = config.permission as Record<string, unknown>;
    const nonQuestionKeys = Object.keys(permission).filter((k) => k !== 'question');
    expect(nonQuestionKeys.length).toBeGreaterThan(0);
    for (const key of nonQuestionKeys) {
      expect(permission[key]).toBe('allow');
    }
  });
});
