/**
 * `ncl` binary entry point.
 *
 * Parses argv, builds a request frame, sends it via the picked transport,
 * formats the response, exits non-zero on error.
 *
 * Usage:
 *   ncl <resource> <verb> [target] [--key value ...] [--stdin-json] [--json]
 *
 * Examples:
 *   ncl groups list
 *   ncl groups get abc123
 *   ncl groups create --name foo --folder bar
 *   ncl groups update abc123 --name baz
 *   ncl help
 *   ncl groups help
 */
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';

import { formatResponse } from './format.js';
import type { RequestFrame } from './frame.js';
import { SocketTransport } from './socket-client.js';
import { readStdinJsonArgs, StdinJsonInputError } from './stdin-json.js';
import type { Transport } from './transport.js';
import { formatTransportError } from './transport-errors.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const { command, args, json, stdinJson } = parseArgv(argv);
  let requestArgs = args;
  if (stdinJson) {
    try {
      requestArgs = await readStdinJsonArgs(process.stdin, args);
    } catch (err) {
      if (!(err instanceof StdinJsonInputError)) throw err;
      process.stderr.write(`ncl: ${err.message}\n`);
      process.exit(2);
    }
  }
  // Stdin is only a client-side encoding for args. The daemon receives the
  // same stable request frame it would receive if every value came from argv.
  const req: RequestFrame = { id: randomUUID(), command, args: requestArgs };
  const transport: Transport = pickTransport();

  let res;
  try {
    res = await transport.sendFrame(req);
  } catch (e) {
    process.stderr.write(formatTransportError(e));
    process.exit(2);
  }

  const output =
    !json && res.ok && res.human !== undefined
      ? res.human + '\n' // server-rendered view — print verbatim
      : formatResponse(res, json ? 'json' : 'human');
  // Exit only after stdout drains: process.exit() discards buffered pipe
  // writes, silently truncating any response past the 64KB pipe buffer
  // (bit `ncl sessions list --json` at scale).
  process.stdout.write(output, () => process.exit(res.ok ? 0 : 1));
}

function pickTransport(): Transport {
  return new SocketTransport();
}

export function parseArgv(argv: string[]): {
  command: string;
  args: Record<string, unknown>;
  json: boolean;
  stdinJson: boolean;
} {
  const positional: string[] = [];
  const args: Record<string, unknown> = {};
  let json = false;
  let stdinJson = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--stdin-json') {
      stdinJson = true;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
      continue;
    }
    positional.push(a);
  }

  if (positional.length === 0) {
    process.stderr.write('ncl: missing command\n');
    printUsage();
    process.exit(2);
  }

  // Join all positionals with dashes to form the command name.
  // If the full name isn't a command, the dispatcher will try trimming
  // the last segment and using it as the target ID (e.g. `groups get abc`
  // → command "groups-get", id "abc").
  const command = positional.join('-');

  return { command, args, json, stdinJson };
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: ncl <resource> <verb> [target] [--key value ...] [--stdin-json] [--json]',
      '',
      '  --stdin-json  Read one bounded JSON object from stdin and merge it with argv flags.',
      '',
      'Run `ncl help` to list available resources and commands.',
      '',
    ].join('\n'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`ncl: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
