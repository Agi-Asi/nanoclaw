/**
 * The step detects gateway /v1 compatibility and installs NanoClaw-owned
 * security guardrails. Tests stay hermetic by injecting the OneCLI command
 * runner; no live gateway is required.
 */
import { describe, expect, it } from 'vitest';

import { GMAIL_LEGACY_GUARDRAILS, ensureGmailLegacyGuardrails, type RunOnecli, verifyGatewayV1 } from './onecli.js';

function fakeFetch(behavior: 'ok' | '404' | 'down'): typeof fetch {
  return (async () => {
    if (behavior === 'down') throw new Error('ECONNREFUSED');
    return { ok: behavior === 'ok' } as Response;
  }) as unknown as typeof fetch;
}

describe('verifyGatewayV1', () => {
  it('ok when /v1/health answers', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('ok'))).toBe('ok');
  });
  it('incompatible when the server answers HTTP without /v1', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('404'))).toBe('incompatible');
  });
  it('unreachable on connection failure', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('down'))).toBe('unreachable');
  });
});

interface TestRule {
  name: string;
  hostPattern: string;
  pathPattern: string;
  action: string;
  enabled: boolean;
}

function flag(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index === -1 || args[index + 1] === undefined) throw new Error(`missing ${name}`);
  return args[index + 1]!;
}

function fakeOnecli(initial: TestRule[] = []): { rules: TestRule[]; calls: string[][]; run: RunOnecli } {
  const rules = initial.map((rule) => ({ ...rule }));
  const calls: string[][] = [];
  const run: RunOnecli = (args) => {
    calls.push(args);
    if (args[0] === 'rules' && args[1] === 'list') return JSON.stringify({ data: rules });
    if (args[0] === 'rules' && args[1] === 'create') {
      rules.push({
        name: flag(args, '--name'),
        hostPattern: flag(args, '--host-pattern'),
        pathPattern: flag(args, '--path-pattern'),
        action: flag(args, '--action'),
        enabled: args.includes('--enabled'),
      });
      return JSON.stringify({ data: rules.at(-1) });
    }
    throw new Error(`unexpected onecli call: ${args.join(' ')}`);
  };
  return { rules, calls, run };
}

describe('ensureGmailLegacyGuardrails', () => {
  it('creates and verifies the three narrow global block rules', () => {
    const onecli = fakeOnecli();

    const result = ensureGmailLegacyGuardrails(onecli.run);

    expect(result.created).toEqual(GMAIL_LEGACY_GUARDRAILS.map((rule) => rule.name));
    expect(onecli.rules).toEqual(GMAIL_LEGACY_GUARDRAILS);
    const creates = onecli.calls.filter((args) => args[1] === 'create');
    expect(creates).toHaveLength(3);
    expect(creates.every((args) => !args.includes('--agent-id'))).toBe(true);
    expect(creates.every((args) => flag(args, '--host-pattern') === 'www.googleapis.com')).toBe(true);
    expect(creates.map((args) => flag(args, '--path-pattern'))).toEqual([
      '/gmail/*',
      '/batch/gmail/*',
      '/upload/gmail/*',
    ]);
  });

  it('is idempotent when every guardrail already has the exact safe shape', () => {
    const onecli = fakeOnecli([...GMAIL_LEGACY_GUARDRAILS]);

    const result = ensureGmailLegacyGuardrails(onecli.run);

    expect(result.created).toEqual([]);
    expect(result.existing).toEqual(GMAIL_LEGACY_GUARDRAILS.map((rule) => rule.name));
    expect(onecli.calls.filter((args) => args[1] === 'create')).toEqual([]);
  });

  it('fails closed on a same-name rule with a weaker shape', () => {
    const weakened = { ...GMAIL_LEGACY_GUARDRAILS[0]!, enabled: false };
    const onecli = fakeOnecli([weakened]);

    expect(() => ensureGmailLegacyGuardrails(onecli.run)).toThrow(/unexpected shape/);
    expect(onecli.calls.filter((args) => args[1] === 'create')).toEqual([]);
  });

  it('fails closed when OneCLI does not persist a created rule', () => {
    const run: RunOnecli = (args) => {
      if (args[1] === 'list') return JSON.stringify({ data: [] });
      return JSON.stringify({ data: {} });
    };

    expect(() => ensureGmailLegacyGuardrails(run)).toThrow(/did not persist Gmail guardrails/);
  });
});
