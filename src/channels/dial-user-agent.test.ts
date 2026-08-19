import fs from 'fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OutboundMessage } from './adapter.js';
import { createDialAdapter } from './dial.js';
import { nanoclawUserAgent } from './dial-user-agent.js';

/** Send one reply through the adapter and hand back the intercepted request. */
async function captureSend(): Promise<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ message: { id: 'msg_1' } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const adapter = createDialAdapter({ apiKey: 'sk_live_test', fromNumber: '+14155550123', cliPath: 'dial' });
  await adapter.deliver('+14155550123', '+15557654321', { content: 'hi' } as unknown as OutboundMessage);
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe('Dial adapter client identification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the NanoClaw user-agent token on the outbound request', async () => {
    const { init } = await captureSend();
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(nanoclawUserAgent());
    expect(headers['User-Agent']).toMatch(/^nanoclaw\//);
  });

  it('carries the API key as a bearer token alongside it', async () => {
    const { init } = await captureSend();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk_live_test');
  });

  it('posts to the documented messages endpoint with the reply payload', async () => {
    const { url, init } = await captureSend();
    expect(url).toBe('https://api.getdial.ai/api/v1/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      to: '+15557654321',
      body: 'hi',
      fromNumber: '+14155550123',
    });
  });

  it('throws on a non-2xx so the send lands on the delivery retry path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const adapter = createDialAdapter({ apiKey: 'sk_live_test', fromNumber: '+14155550123', cliPath: 'dial' });
    await expect(
      adapter.deliver('+14155550123', '+15557654321', { content: 'hi' } as unknown as OutboundMessage),
    ).rejects.toThrow(/Dial API error 500/);
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
