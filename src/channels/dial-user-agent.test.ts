import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const constructed: Array<Record<string, unknown>> = [];

// Capture what the adapter hands the SDK. The real client would open a network
// stack on construction, so it's replaced wholesale.
vi.mock('@getdial/sdk', () => ({
  DialClient: class {
    constructor(config: Record<string, unknown>) {
      constructed.push(config);
    }
  },
}));

import { createDialAdapter } from './dial.js';
import { nanoclawUserAgent } from './dial-user-agent.js';

describe('Dial adapter client identification', () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  it('passes the NanoClaw user-agent token to DialClient', () => {
    createDialAdapter({ apiKey: 'sk_live_test', fromNumber: '+14155550123', cliPath: 'dial' });
    expect(constructed).toHaveLength(1);
    expect(constructed[0].userAgent).toBe(nanoclawUserAgent());
    expect(constructed[0].userAgent).toMatch(/^nanoclaw\//);
  });

  it('still passes the API key alongside it', () => {
    createDialAdapter({ apiKey: 'sk_live_test', fromNumber: '+14155550123', cliPath: 'dial' });
    expect(constructed[0].apiKey).toBe('sk_live_test');
  });
});

// The module caches after the first call, so each test re-imports it fresh.
async function freshToken(): Promise<string> {
  vi.resetModules();
  const mod = await import('./dial-user-agent.js');
  return mod.nanoclawUserAgent();
}

describe('nanoclawUserAgent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is nanoclaw/<semver> from this repo's package.json", async () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string };
    expect(await freshToken()).toBe(`nanoclaw/${pkg.version}`);
  });

  it('degrades to nanoclaw/unknown rather than throwing when package.json is unreadable', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(await freshToken()).toBe('nanoclaw/unknown');
  });

  it('degrades to nanoclaw/unknown when package.json carries no version field', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{"name":"nanoclaw"}');
    expect(await freshToken()).toBe('nanoclaw/unknown');
  });

  it('carries no CR/LF, which would make the header itself unsendable', () => {
    expect(nanoclawUserAgent()).not.toMatch(/[\r\n]/);
  });
});
