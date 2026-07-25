import { describe, it, expect, afterEach } from 'bun:test';

import { buildOpenCodeConfig } from './opencode.js';

const ENV_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'ANTHROPIC_BASE_URL',
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
  'OPENCODE_MODEL_INPUT_MODALITIES',
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

  it('openrouter with a base URL keeps its native transport (no pin)', () => {
    process.env.OPENCODE_PROVIDER = 'openrouter';
    process.env.OPENCODE_MODEL = 'openrouter/some/model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
    const config = buildOpenCodeConfig({});
    const entry = (config.provider as Record<string, Record<string, unknown>>).openrouter;
    expect(entry.npm).toBeUndefined();
  });

  it('openai with a base URL still pins the Chat Completions transport', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/some/local-model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
    const config = buildOpenCodeConfig({});
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    expect(entry.npm).toBe('@ai-sdk/openai-compatible');
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

describe('buildOpenCodeConfig model input modalities', () => {
  function models(config: Record<string, unknown>) {
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    return (entry.models as Record<string, Record<string, unknown>>)['some/local-model'];
  }

  function customModelEnv() {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/some/local-model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
  }

  it('declares attachment + modalities so file parts survive the model call', () => {
    customModelEnv();
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = 'image,pdf';
    const model = models(buildOpenCodeConfig({}));
    expect(model.attachment).toBe(true);
    // `text` is always prepended: the declared input list REPLACES the defaults,
    // so omitting it would turn off text input on the model entry.
    expect(model.modalities).toEqual({ input: ['text', 'image', 'pdf'], output: ['text'] });
  });

  it('omits both capability keys when the env var is unset', () => {
    customModelEnv();
    delete process.env.OPENCODE_MODEL_INPUT_MODALITIES;
    const model = models(buildOpenCodeConfig({}));
    expect(model.attachment).toBeUndefined();
    expect(model.modalities).toBeUndefined();
  });

  it('omits both capability keys when the env var is empty or only separators', () => {
    customModelEnv();
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = ' , ,';
    const model = models(buildOpenCodeConfig({}));
    expect(model.attachment).toBeUndefined();
    expect(model.modalities).toBeUndefined();
  });

  it('drops entries outside the schema enum and keeps the valid ones', () => {
    customModelEnv();
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = ' IMAGE , hologram, pdf ,image';
    const model = models(buildOpenCodeConfig({}));
    expect(model.modalities).toEqual({ input: ['text', 'image', 'pdf'], output: ['text'] });
  });

  it('does not duplicate text when the operator lists it explicitly', () => {
    customModelEnv();
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = 'text,image';
    const model = models(buildOpenCodeConfig({}));
    expect(model.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
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
