import { describe, it, expect } from 'vitest';

import { cliApprovalExecuted, cliApprovalFailed, cliApprovalQuestion, formatCliCommand } from './approval-render.js';

// The live specimen this module exists for: an agent registering a stamp,
// whose --config manifest is exactly what the admin is signing off on.
const MANIFEST = JSON.stringify({
  app: { image: 'traefik/whoami:v1.10.1', port: 80, env: { WHOAMI_NAME: 'whoami' } },
});

describe('formatCliCommand', () => {
  it('renders the command on one line and each arg on its own line', () => {
    const out = formatCliCommand('stamps-create', { id: 'whoami', config: MANIFEST });
    const lines = out.split('\n');
    expect(lines[0]).toBe('ncl stamps-create');
    expect(lines[1]).toBe('  --id whoami');
    expect(lines[2]).toBe('  --config');
  });

  it('pretty-prints an escaped-JSON arg value as an indented block, not escape soup', () => {
    const out = formatCliCommand('stamps-create', { config: MANIFEST });
    expect(out).toContain('    {\n      "app": {');
    expect(out).toContain('        "image": "traefik/whoami:v1.10.1"');
    expect(out).not.toContain('\\"');
  });

  it('pretty-prints a value that is already an object', () => {
    const out = formatCliCommand('stamps-create', { config: { app: { port: 80 } } });
    expect(out).toContain('    {\n      "app": {\n        "port": 80\n      }\n    }');
  });

  it('keeps non-JSON and JSON-scalar strings inline', () => {
    const out = formatCliCommand('groups-update', { name: 'My Group', size: '8080', broken: '{not json' });
    expect(out).toContain('  --name My Group');
    expect(out).toContain('  --size 8080');
    expect(out).toContain('  --broken {not json');
  });

  it('renders a boolean true as a bare flag', () => {
    expect(formatCliCommand('stamps-list', { live: true })).toBe('ncl stamps-list\n  --live');
  });

  it('renders a command with no args as the bare command line', () => {
    expect(formatCliCommand('help', {})).toBe('ncl help');
  });

  it('truncates a huge inline value with a marker, never mid-escape', () => {
    const huge = `${'x'.repeat(399)}\\uD83D rest`;
    const out = formatCliCommand('groups-update', { note: huge });
    expect(out).toContain('… [truncated]');
    // The cut fell on the lone backslash of \uD83D — the whole escape is dropped.
    expect(out).not.toContain('\\…');
    expect(out).not.toContain('rest');
  });

  it('truncates by code point so an astral character is kept or dropped whole', () => {
    const huge = 'x'.repeat(399) + '🎉🎉🎉';
    const out = formatCliCommand('groups-update', { note: huge });
    // The cut lands between emoji, never through one — no lone surrogate half.
    expect(out.split('\n')[1]).toBe(`  --note ${'x'.repeat(399)}🎉… [truncated]`);
  });

  it('truncates a huge string inside a manifest per line, keeping the structure readable', () => {
    const out = formatCliCommand('stamps-create', {
      config: JSON.stringify({ app: { image: 'ok', blob: 'y'.repeat(2000) } }),
    });
    expect(out).toContain('"image": "ok"');
    expect(out).toContain('… [truncated]');
    expect(out).not.toContain('y'.repeat(500));
  });
});

describe('cliApprovalQuestion', () => {
  it('names the agent and fences the command block', () => {
    const out = cliApprovalQuestion('seed-assistant', 'stamps-create', { id: 'whoami', config: MANIFEST });
    expect(out.startsWith('Agent "seed-assistant" wants to run:\n```\nncl stamps-create\n')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
  });

  it('keeps backticks in values from closing the fence', () => {
    const out = cliApprovalQuestion('a', 'groups-update', { name: 'tick ``` tock' });
    // Exactly the outer fence pair survives; embedded runs are broken by the word joiner.
    expect(out.match(/```/g)).toHaveLength(2);
    expect(out).toContain('`\u2060`\u2060`\u2060');
  });

  it('clamps an oversized body to whole lines inside the fence', () => {
    const args = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${i}`, 'v'.repeat(80)]));
    const out = cliApprovalQuestion('a', 'groups-update', args);
    expect(out.length).toBeLessThan(3000);
    expect(out.endsWith('… [truncated]\n```')).toBe(true);
    // Every kept arg line is intact — the clamp never splits a line.
    for (const line of out.split('\n').slice(3, -2)) {
      expect(line).toMatch(/^ {2}--key\d+ v+$/);
    }
  });

  it('survives unicode arg values untouched when under the limits', () => {
    const out = cliApprovalQuestion('émile', 'groups-update', { name: 'グループ 🎉' });
    expect(out).toContain('Agent "émile"');
    expect(out).toContain('  --name グループ 🎉');
  });
});

describe('post-approval notes', () => {
  it('states the outcome, the role, and that the command ran — with the result block', () => {
    const out = cliApprovalExecuted('stamps-create', 'whoami  v1  active  pool=0  author=g1');
    expect(out).toBe(
      'Your `ncl stamps-create` request was approved by an admin and the command ran.\n\n' +
        'Result:\nwhoami  v1  active  pool=0  author=g1',
    );
  });

  it('omits the result block when the command returned nothing', () => {
    for (const result of ['', '  \n ', undefined]) {
      expect(cliApprovalExecuted('groups-restart', result)).toBe(
        'Your `ncl groups-restart` request was approved by an admin and the command ran.',
      );
    }
  });

  it('clamps a huge result to whole lines with a marker', () => {
    const rows = Array.from({ length: 300 }, (_, i) => `row ${i} ${'x'.repeat(40)}`);
    const out = cliApprovalExecuted('stamps-list', rows.join('\n'));
    expect(out.length).toBeLessThan(4300);
    expect(out.endsWith('… [truncated]')).toBe(true);
  });

  it('names the failure without leaking anything else', () => {
    expect(cliApprovalFailed('stamps-create', "no stamp 'x'")).toBe(
      "Your `ncl stamps-create` request was approved by an admin, but the command failed: no stamp 'x'",
    );
  });
});
