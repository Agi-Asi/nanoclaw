import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { AgentNotFoundError, CursorAgentError, type SDKMessage } from '@cursor/sdk';

import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import {
  CURSOR_API_KEY_PLACEHOLDER,
  CURSOR_DISALLOWED_TOOLS,
  CursorProvider,
  createContentLengthFetch,
  cursorAgentApi,
  extractAssistantText,
  mapMcpServers,
  toolProgressMessage,
  waitForRunWithActivity,
} from './cursor.js';

let homeDir: string;
let agentDir: string;
let conversationsDir: string;
let previousHome: string | undefined;
let previousAgentDir: string | undefined;
let previousConversations: string | undefined;
let previousApiKey: string | undefined;
let previousNoProxy: string | undefined;
let previousLowerNoProxy: string | undefined;

const TEST_ROOT = path.join(import.meta.dir, '..', '..', '.tmp-cursor-factory');

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  homeDir = fs.mkdtempSync(path.join(TEST_ROOT, 'home-'));
  agentDir = fs.mkdtempSync(path.join(TEST_ROOT, 'agent-'));
  conversationsDir = fs.mkdtempSync(path.join(TEST_ROOT, 'conv-'));
  previousHome = process.env.HOME;
  previousAgentDir = process.env.NANOCLAW_AGENT_DIR;
  previousConversations = process.env.NANOCLAW_CONVERSATIONS_DIR;
  previousApiKey = process.env.CURSOR_API_KEY;
  previousNoProxy = process.env.NO_PROXY;
  previousLowerNoProxy = process.env.no_proxy;
  process.env.HOME = homeDir;
  process.env.NANOCLAW_AGENT_DIR = agentDir;
  process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
  delete process.env.CURSOR_API_KEY;
  fs.mkdirSync(path.join(agentDir, 'memory', 'system'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'memory', 'index.md'), 'factory-memory-sentinel\n');
  fs.writeFileSync(path.join(agentDir, 'memory', 'system', 'definition.md'), 'factory-definition\n');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDir === undefined) delete process.env.NANOCLAW_AGENT_DIR;
  else process.env.NANOCLAW_AGENT_DIR = previousAgentDir;
  if (previousConversations === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
  else process.env.NANOCLAW_CONVERSATIONS_DIR = previousConversations;
  if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = previousApiKey;
  if (previousNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = previousNoProxy;
  if (previousLowerNoProxy === undefined) delete process.env.no_proxy;
  else process.env.no_proxy = previousLowerNoProxy;
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.rmSync(conversationsDir, { recursive: true, force: true });
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

async function collect(provider: CursorProvider, input: { prompt: string; cwd: string; continuation?: string }) {
  const events = [];
  for await (const event of provider.query(input).events) events.push(event);
  return events;
}

describe('mapMcpServers / stream helpers', () => {
  it('sets Content-Length for Connect protobuf bodies without buffering responses', async () => {
    let received: RequestInit | undefined;
    const response = new Response('streamed');
    const wrapped = createContentLengthFetch((async (_input, init) => {
      received = init;
      return response;
    }) as typeof fetch);

    const actual = await wrapped('https://api2.cursor.sh/rpc', {
      method: 'POST',
      body: new Uint8Array([1, 2]),
      headers: { 'content-type': 'application/proto' },
    });

    expect(new Headers(received?.headers).get('content-length')).toBe('2');
    expect(received?.body).toBeInstanceOf(Uint8Array);
    expect(actual).toBe(response);
  });

  it('does not bypass the configured proxy for Cursor requests', async () => {
    process.env.NO_PROXY = 'localhost';
    process.env.no_proxy = 'localhost';
    const observed: string[] = [];
    const wrapped = createContentLengthFetch((async () => {
      observed.push(process.env.NO_PROXY ?? '');
      return new Response('{}');
    }) as typeof fetch);

    await wrapped('https://api2.cursor.sh/auth/exchange_user_api_key', {
      method: 'POST',
      body: '{}',
    });
    await wrapped('https://api2.cursor.sh/aiserver.v1.DashboardService/GetUserPrivacyMode', {
      method: 'POST',
      body: new Uint8Array([0, 0, 0, 0, 0]),
    });

    expect(observed).toEqual(['localhost', 'localhost']);
    expect(process.env.NO_PROXY).toBe('localhost');
    expect(process.env.no_proxy).toBe('localhost');
  });

  it('maps NanoClaw stdio and HTTP MCP configs without dropping transport fields', () => {
    expect(
      mapMcpServers({
        nanoclaw: {
          command: 'bun',
          args: ['/app/src/mcp.ts'],
          env: { A: '1' },
          cwd: '/workspace/plugin',
        },
        remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer token' } },
      }),
    ).toEqual({
      nanoclaw: {
        type: 'stdio',
        command: 'bun',
        args: ['/app/src/mcp.ts'],
        env: { A: '1' },
        cwd: '/workspace/plugin',
      },
      remote: {
        type: 'http',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer token' },
      },
    });
  });

  it('preserves MCP server names that overlap object prototype keys', () => {
    const mapped = mapMcpServers(
      JSON.parse('{"__proto__":{"command":"safe","args":[],"env":{}}}') as Record<
        string,
        { command: string; args: string[]; env: Record<string, string> }
      >,
    );
    expect(Object.hasOwn(mapped, '__proto__')).toBe(true);
    expect(mapped.__proto__).toEqual({ type: 'stdio', command: 'safe', args: [], env: {} });
  });

  it('extracts assistant text and tool progress from stream events', () => {
    const assistant: SDKMessage = {
      type: 'assistant',
      agent_id: 'agent-1',
      run_id: 'run-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };
    const tool: SDKMessage = {
      type: 'tool_call',
      agent_id: 'agent-1',
      run_id: 'run-1',
      call_id: 'c1',
      name: 'shell',
      status: 'running',
    };
    expect(extractAssistantText(assistant)).toBe('hello');
    expect(toolProgressMessage(tool)).toBe('shell…');
  });

  it('disallows Cursor askQuestion, await, and task in favour of NanoClaw ask_user_question', () => {
    expect(CURSOR_DISALLOWED_TOOLS).toEqual(['askQuestion', 'await', 'task']);
  });

  it('keeps the poll-loop heartbeat alive while waiting without stream events', async () => {
    let finish!: (result: { id: string; status: 'finished'; result: string }) => void;
    const wait = new Promise<{ id: string; status: 'finished'; result: string }>((resolve) => {
      finish = resolve;
    });
    const events = waitForRunWithActivity({ wait: () => wait }, 1);

    expect(await events.next()).toEqual({ done: false, value: { type: 'activity' } });
    finish({ id: 'run-wait', status: 'finished', result: 'done' });
    expect(await events.next()).toEqual({
      done: true,
      value: { id: 'run-wait', status: 'finished', result: 'done' },
    });
  });
});

describe('CursorProvider', () => {
  it('requires the shared memory hook before starting a query', () => {
    expect(() => new CursorProvider({}).query({ prompt: 'hello', cwd: agentDir })).toThrow(/not registered/);
  });

  it('writes sessionStart / preCompact hooks under the project and $HOME', () => {
    const provider = new CursorProvider();
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const projectHooks = JSON.parse(fs.readFileSync(path.join(agentDir, '.cursor', 'hooks.json'), 'utf-8')) as {
      hooks: { sessionStart: Array<{ command: string }>; preCompact: Array<{ command: string }> };
    };
    const homeHooks = JSON.parse(fs.readFileSync(path.join(homeDir, '.cursor', 'hooks.json'), 'utf-8'));
    expect(projectHooks.hooks.sessionStart[0]?.command).toContain('cursor-hook.ts');
    expect(projectHooks.hooks.preCompact[0]?.command).toContain('--compact');
    expect(homeHooks).toEqual(projectHooks);
  });

  it('preserves unrelated Cursor hooks and does not duplicate NanoClaw hooks', () => {
    const projectCursorDir = path.join(agentDir, '.cursor');
    const homeCursorDir = path.join(homeDir, '.cursor');
    fs.mkdirSync(projectCursorDir, { recursive: true });
    fs.mkdirSync(homeCursorDir, { recursive: true });
    const existing = {
      version: 1,
      custom: { keep: true },
      hooks: {
        sessionStart: [{ command: 'bun custom-start.ts' }],
        stop: [{ command: 'bun custom-stop.ts' }],
      },
    };
    fs.writeFileSync(path.join(projectCursorDir, 'hooks.json'), JSON.stringify(existing));
    fs.writeFileSync(path.join(homeCursorDir, 'hooks.json'), JSON.stringify(existing));

    const provider = new CursorProvider();
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

    for (const file of [path.join(projectCursorDir, 'hooks.json'), path.join(homeCursorDir, 'hooks.json')]) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        custom: { keep: boolean };
        hooks: Record<string, Array<{ command: string }>>;
      };
      expect(doc.custom).toEqual({ keep: true });
      expect(doc.hooks.stop).toEqual([{ command: 'bun custom-stop.ts' }]);
      expect(doc.hooks.sessionStart.map((hook) => hook.command)).toEqual([
        'bun custom-start.ts',
        'bun /app/src/providers/cursor-hook.ts',
      ]);
      expect(doc.hooks.preCompact).toEqual([{ command: 'bun /app/src/providers/cursor-hook.ts --compact' }]);
    }
  });

  it('repairs malformed Cursor hook documents instead of blocking the provider', () => {
    const projectCursorDir = path.join(agentDir, '.cursor');
    fs.mkdirSync(projectCursorDir, { recursive: true });
    fs.writeFileSync(path.join(projectCursorDir, 'hooks.json'), '{broken');

    const provider = new CursorProvider();
    expect(() => provider.registerMemorySessionHook(MEMORY_SESSION_HOOK)).not.toThrow();
    const repaired = JSON.parse(fs.readFileSync(path.join(projectCursorDir, 'hooks.json'), 'utf-8')) as {
      hooks: { sessionStart: Array<{ command: string }> };
    };
    expect(repaired.hooks.sessionStart[0]?.command).toContain('cursor-hook.ts');
  });

  it('treats AgentNotFoundError as an invalid session', () => {
    const provider = new CursorProvider();
    expect(provider.isSessionInvalid(new AgentNotFoundError('missing'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('no conversation'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('model not found'))).toBe(false);
    expect(provider.isSessionInvalid(new Error('rate limited'))).toBe(false);
  });

  it('rotates once per size-cap growth interval instead of rotating every new continuation', () => {
    const provider = new CursorProvider();
    const store = path.join(homeDir, '.cursor');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'big.bin'), Buffer.alloc(51 * 1024 * 1024));
    expect(provider.maybeRotateContinuation('agent-1')).toMatch(/50MB cap/);
    expect(provider.maybeRotateContinuation('agent-2')).toBeNull();

    fs.writeFileSync(path.join(store, 'more.bin'), Buffer.alloc(51 * 1024 * 1024));
    expect(provider.maybeRotateContinuation('agent-2')).toMatch(/50MB cap/);
  });

  it('archives completed exchanges as markdown', () => {
    const provider = new CursorProvider({ assistantName: 'Cursor' });
    provider.onExchangeComplete?.({ prompt: 'hi', result: 'hello', status: 'completed' });
    const files = fs.readdirSync(conversationsDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBe(1);
    const body = fs.readFileSync(path.join(conversationsDir, files[0]!), 'utf-8');
    expect(body).toContain('**User**: hi');
    expect(body).toContain('**Cursor**: hello');
  });

  it('does not overwrite exchanges completed in the same second', () => {
    const provider = new CursorProvider({ assistantName: 'Cursor' });
    provider.onExchangeComplete?.({ prompt: 'first', result: 'one', status: 'completed' });
    provider.onExchangeComplete?.({ prompt: 'second', result: 'two', status: 'completed' });

    const files = fs.readdirSync(conversationsDir).filter((file) => file.endsWith('.md'));
    expect(files.length).toBe(2);
    const bodies = files.map((file) => fs.readFileSync(path.join(conversationsDir, file), 'utf-8')).join('\n');
    expect(bodies).toContain('**User**: first');
    expect(bodies).toContain('**User**: second');
  });

  it('creates, streams, and waits — yielding init/activity/result', async () => {
    const original = { ...cursorAgentApi };
    process.env.CURSOR_API_KEY = 'must_not_reach_cursor_sdk';
    cursorAgentApi.create = async (options) => {
      expect(options.apiKey).toBe(CURSOR_API_KEY_PLACEHOLDER);
      expect(options.model).toEqual({ id: 'composer-2.5' });
      expect(options.disallowedTools).toEqual(['askQuestion', 'await', 'task']);
      expect(options.local?.sandboxOptions).toEqual({ enabled: false });
      return {
        agentId: 'agent-created',
        send: async () => ({
          supports: (op: string) => op === 'stream' || op === 'wait' || op === 'cancel',
          stream: async function* () {
            yield {
              type: 'assistant',
              agent_id: 'agent-created',
              run_id: 'run-1',
              message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
            } satisfies SDKMessage;
          },
          wait: async () => ({ id: 'run-1', status: 'finished' as const, result: 'ok' }),
          cancel: async () => {},
        }),
        close: () => {},
      } as never;
    };
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const events = await collect(provider, { prompt: 'hi', cwd: agentDir });
      expect(events[0]).toEqual({ type: 'init', continuation: 'agent-created' });
      expect(events.some((e) => e.type === 'activity')).toBe(true);
      expect(events.at(-1)).toEqual({ type: 'result', text: 'ok' });
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('resumes an existing agent, processes pushed follow-ups, and prepends system instructions to each', async () => {
    const original = { ...cursorAgentApi };
    const sent: string[] = [];
    cursorAgentApi.resume = async (id) => {
      expect(id).toBe('agent-resume');
      return {
        agentId: id,
        send: async (prompt: string) => {
          sent.push(prompt);
          return {
            supports: (op: string) => op === 'wait',
            wait: async () => ({ id: 'run-2', status: 'finished' as const, result: 'resumed' }),
            cancel: async () => {},
          };
        },
        close: () => {},
      } as never;
    };
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const query = provider.query({
        prompt: 'follow-up',
        cwd: agentDir,
        continuation: 'agent-resume',
        systemContext: { instructions: 'Be brief.' },
      });
      query.push('follow-up while active');
      query.end();
      const events = [];
      for await (const event of query.events) events.push(event);
      expect(sent[0]).toContain('Be brief.');
      expect(sent[0]).toContain('factory-memory-sentinel');
      expect(sent[0]).toContain('follow-up');
      expect(sent[1]).toBe('Be brief.\n\nfollow-up while active');
      expect(sent[1]).not.toContain('factory-memory-sentinel');
      expect(events[0]).toEqual({ type: 'init', continuation: 'agent-resume' });
      expect(events.filter((event) => event.type === 'result')).toHaveLength(2);
      expect(events.at(-1)).toEqual({ type: 'result', text: 'resumed' });
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('passes custom model, name, directories, MCP servers, and instructions on create', async () => {
    const original = { ...cursorAgentApi };
    let sent = '';
    cursorAgentApi.create = async (options) => {
      expect(options.name).toBe('Buildbot');
      expect(options.model).toEqual({ id: 'cursor-custom' });
      expect(options.local?.cwd).toBe(agentDir);
      expect(options.local?.dirs).toEqual(['/workspace/shared', '/workspace/docs']);
      expect(options.local?.settingSources).toEqual(['project', 'user']);
      expect(options.mcpServers).toEqual({
        first: { type: 'stdio', command: 'bun', args: ['one.ts'], env: { TOKEN: 'placeholder' } },
        second: { type: 'stdio', command: 'node', args: ['two.js'], env: {} },
      });
      return {
        agentId: 'agent-options',
        send: async (prompt: string) => {
          sent = prompt;
          return {
            supports: (op: string) => op === 'wait',
            wait: async () => ({ id: 'run-options', status: 'finished' as const, result: 'done' }),
            cancel: async () => {},
          };
        },
        close: () => {},
      } as never;
    };
    try {
      const provider = new CursorProvider({
        assistantName: 'Buildbot',
        model: 'cursor-custom',
        additionalDirectories: ['/workspace/shared', '/workspace/docs'],
        mcpServers: {
          first: { command: 'bun', args: ['one.ts'], env: { TOKEN: 'placeholder' } },
          second: { command: 'node', args: ['two.js'], env: {} },
        },
      });
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const events = await collect(provider, {
        prompt: 'build it',
        cwd: agentDir,
        systemContext: { instructions: 'Use the configured MCP tools.' },
      });
      expect(sent).toContain('Use the configured MCP tools.');
      expect(sent).toContain('factory-memory-sentinel');
      expect(sent).toContain('build it');
      expect(sent.startsWith('Use the configured MCP tools.')).toBe(true);
      expect(sent.endsWith('build it')).toBe(true);
      expect(events.at(-1)).toEqual({ type: 'result', text: 'done' });
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('accepts a corrective push after yielding a result', async () => {
    const original = { ...cursorAgentApi };
    const sent: string[] = [];
    cursorAgentApi.create = async () =>
      ({
        agentId: 'agent-corrective-push',
        send: async (prompt: string) => {
          sent.push(prompt);
          return {
            supports: (op: string) => op === 'wait',
            wait: async () => ({
              id: `run-${sent.length}`,
              status: 'finished' as const,
              result: `result-${sent.length}`,
            }),
            cancel: async () => {},
          };
        },
        close: () => {},
      }) as never;
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const query = provider.query({ prompt: 'initial', cwd: agentDir });
      const iterator = query.events[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: 'init', continuation: 'agent-corrective-push' });
      expect((await iterator.next()).value).toEqual({ type: 'activity' });
      expect((await iterator.next()).value).toEqual({ type: 'result', text: 'result-1' });

      query.push('wrap the answer');

      expect((await iterator.next()).value).toEqual({ type: 'activity' });
      expect((await iterator.next()).value).toEqual({ type: 'result', text: 'result-2' });
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
      expect(sent[0]).toContain('factory-memory-sentinel');
      expect(sent[0]).toContain('initial');
      expect(sent[1]).toBe('wrap the answer');
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('recovers a resumed agent whose persisted run was left active by a crash', async () => {
    const original = { ...cursorAgentApi };
    const sends: Array<{ prompt: string; force?: boolean }> = [];
    cursorAgentApi.resume = async () =>
      ({
        agentId: 'agent-stale-run',
        send: async (prompt: string, options?: { local?: { force?: boolean } }) => {
          sends.push({ prompt, force: options?.local?.force });
          if (sends.length === 1) throw new Error('Agent agent-stale-run already has active run');
          return {
            supports: (op: string) => op === 'wait',
            wait: async () => ({ id: 'run-recovered', status: 'finished' as const, result: 'recovered' }),
            cancel: async () => {},
          };
        },
        close: () => {},
      }) as never;
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const events = await collect(provider, {
        prompt: 'continue',
        cwd: agentDir,
        continuation: 'agent-stale-run',
      });
      expect(sends).toHaveLength(2);
      expect(sends[0]?.force).toBeUndefined();
      expect(sends[1]?.force).toBe(true);
      expect(sends[0]?.prompt).toContain('factory-memory-sentinel');
      expect(sends[0]?.prompt).toContain('continue');
      expect(sends[1]?.prompt).toBe(sends[0]?.prompt);
      expect(events.at(-1)).toEqual({ type: 'result', text: 'recovered' });
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('propagates an invalid continuation so the poll loop can clear it', async () => {
    const original = { ...cursorAgentApi };
    cursorAgentApi.resume = async () => {
      throw new AgentNotFoundError('missing');
    };
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      await expect(
        collect(provider, {
          prompt: 'continue',
          cwd: agentDir,
          continuation: 'agent-missing',
        }),
      ).rejects.toBeInstanceOf(AgentNotFoundError);
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('maps every terminal run state and falls back to streamed assistant text', async () => {
    const original = { ...cursorAgentApi };
    const cases = [
      {
        result: { id: 'run-finished', status: 'finished' as const },
        streamText: 'stream fallback',
        expected: { type: 'result', text: 'stream fallback' },
      },
      {
        result: { id: 'run-error', status: 'error' as const, result: 'partial', error: { message: 'model failed' } },
        streamText: 'streamed',
        expected: { type: 'result', text: 'model failed', isError: true },
      },
      {
        result: { id: 'run-cancelled', status: 'cancelled' as const },
        streamText: '',
        expected: { type: 'result', text: 'Cancelled', isError: true },
      },
    ];
    try {
      for (const testCase of cases) {
        let closed = 0;
        cursorAgentApi.create = async () =>
          ({
            agentId: `agent-${testCase.result.id}`,
            send: async () => ({
              supports: (op: string) => op === 'stream' || op === 'wait',
              stream: async function* () {
                if (testCase.streamText) {
                  yield {
                    type: 'assistant',
                    agent_id: 'agent',
                    run_id: testCase.result.id,
                    message: { role: 'assistant', content: [{ type: 'text', text: testCase.streamText }] },
                  } satisfies SDKMessage;
                }
              },
              wait: async () => testCase.result,
              cancel: async () => {},
            }),
            close: () => {
              closed += 1;
            },
          }) as never;
        const provider = new CursorProvider();
        provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
        const events = await collect(provider, { prompt: 'state', cwd: agentDir });
        expect(events.at(-1)).toEqual(testCase.expected);
        if (testCase.result.status === 'cancelled') {
          expect(events).toContainEqual({ type: 'error', message: 'Cancelled', retryable: false });
        }
        expect(closed).toBe(1);
      }
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('closes the agent after send, stream, and wait failures', async () => {
    const original = { ...cursorAgentApi };
    try {
      for (const stage of ['send', 'stream', 'wait'] as const) {
        let closed = 0;
        cursorAgentApi.create = async () =>
          ({
            agentId: `agent-${stage}`,
            send: async () => {
              if (stage === 'send') throw new Error('send exploded');
              return {
                supports: (op: string) => op === 'wait' || (stage === 'stream' && op === 'stream'),
                stream: async function* () {
                  throw new Error('stream exploded');
                },
                wait: async () => {
                  if (stage === 'wait') throw new Error('wait exploded');
                  return { id: 'unused', status: 'finished' as const };
                },
                cancel: async () => {},
              };
            },
            close: () => {
              closed += 1;
            },
          }) as never;
        const provider = new CursorProvider();
        provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
        const events = await collect(provider, { prompt: stage, cwd: agentDir });
        expect(events).toContainEqual({ type: 'error', message: `${stage} exploded`, retryable: false });
        expect(events.at(-1)).toEqual({ type: 'result', text: `${stage} exploded`, isError: true });
        expect(closed).toBe(1);
      }
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('aborts safely while agent creation is pending', async () => {
    const original = { ...cursorAgentApi };
    let resolveCreate!: (agent: unknown) => void;
    let closed = 0;
    cursorAgentApi.create = (() =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      })) as typeof cursorAgentApi.create;
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const query = provider.query({ prompt: 'abort', cwd: agentDir });
      const iterator = query.events[Symbol.asyncIterator]();
      const pending = iterator.next();
      query.abort();
      resolveCreate({
        agentId: 'agent-aborted',
        send: async () => {
          throw new Error('must not send');
        },
        close: () => {
          closed += 1;
        },
      });
      expect(await pending).toEqual({ done: true, value: undefined });
      expect(closed).toBe(1);
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('cancels exactly once when aborted while send is pending and swallows cancellation failure', async () => {
    const original = { ...cursorAgentApi };
    let resolveSend!: (run: unknown) => void;
    let cancelCalls = 0;
    let closed = 0;
    cursorAgentApi.create = async () =>
      ({
        agentId: 'agent-abort-send',
        send: () =>
          new Promise((resolve) => {
            resolveSend = resolve;
          }),
        close: () => {
          closed += 1;
        },
      }) as never;
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const query = provider.query({ prompt: 'abort', cwd: agentDir });
      const iterator = query.events[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({
        done: false,
        value: { type: 'init', continuation: 'agent-abort-send' },
      });
      expect(await iterator.next()).toEqual({ done: false, value: { type: 'activity' } });
      const pending = iterator.next();
      query.abort();
      resolveSend({
        supports: (op: string) => op === 'cancel',
        cancel: async () => {
          cancelCalls += 1;
          throw new Error('cancel exploded');
        },
      });
      expect(await pending).toEqual({ done: true, value: undefined });
      expect(cancelCalls).toBe(1);
      expect(closed).toBe(1);
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('maps CursorAgentError retryability onto provider error events', async () => {
    const original = { ...cursorAgentApi };
    cursorAgentApi.create = async () => {
      throw new CursorAgentError('upstream blip', { isRetryable: true, code: 'network' });
    };
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const events = await collect(provider, { prompt: 'hi', cwd: agentDir });
      expect(events).toContainEqual({
        type: 'error',
        message: 'upstream blip',
        retryable: true,
        classification: 'network',
      });
      expect(events.at(-1)).toEqual({ type: 'result', text: 'upstream blip', isError: true });
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });
});
