/**
 * Cursor SDK agent provider — local runtime inside the container.
 *
 * Talks to `@cursor/sdk` (`Agent.create` / `resume` / `send`). Continuation is
 * the Cursor `agentId`. The host passes `CURSOR_API_KEY=placeholder` so the SDK
 * emits an Authorization header and OneCLI rewrites it for Cursor's
 * key-exchange and model-discovery requests. The SDK holds the short-lived
 * access token returned by the exchange, but all later traffic still uses the
 * configured proxy.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AgentOptions, McpServerConfig as CursorMcpServerConfig, Run, RunResult, SDKMessage } from '@cursor/sdk';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderExchange,
  ProviderOptions,
  QueryInput,
} from './types.js';

const CONTENT_LENGTH_FETCH = Symbol.for('nanoclaw.cursor.content-length-fetch');
type MarkedFetch = typeof fetch & { [CONTENT_LENGTH_FETCH]?: boolean };

function knownBodyLength(body: BodyInit | null | undefined): number | null {
  if (body == null) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return null;
}

/**
 * Keep all Cursor traffic behind the configured proxy. Supplying known body
 * lengths prevents Bun from sending Connect protobuf bodies as chunked streams,
 * which OneCLI cannot currently forward without stalling.
 */
export function createContentLengthFetch(fetchImpl: typeof fetch): typeof fetch {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const length = knownBodyLength(init?.body);
    const nextInit = length == null ? init : { ...init, headers: new Headers(init?.headers) };
    if (length != null) {
      const headers = (nextInit as RequestInit).headers as Headers;
      if (!headers.has('content-length')) headers.set('content-length', String(length));
    }
    return fetchImpl(input, nextInit);
  }) as MarkedFetch;
  wrapped[CONTENT_LENGTH_FETCH] = true;
  return wrapped;
}

const currentFetch = globalThis.fetch as MarkedFetch;
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !currentFetch[CONTENT_LENGTH_FETCH]) {
  globalThis.fetch = createContentLengthFetch(currentFetch);
}

let cursorSdkPromise: Promise<typeof import('@cursor/sdk')> | undefined;

async function loadCursorSdk(): Promise<typeof import('@cursor/sdk')> {
  cursorSdkPromise ??= import('@cursor/sdk').then((sdk) => {
    // Cursor's local runtime stream defaults can use HTTP/2 on Node. OneCLI is
    // an authenticated HTTP proxy, so force the documented proxy-safe SSE path.
    sdk.Cursor.configure({ local: { useHttp1ForAgent: true } });
    return sdk;
  });
  return cursorSdkPromise;
}

/** Sentinel so the SDK always sends Authorization for OneCLI to overwrite. */
export const CURSOR_API_KEY_PLACEHOLDER = 'cursor_placeholder_nanoclaw';

/**
 * Built-in Cursor tools that stall a headless session or bypass NanoClaw
 * `ask_user_question`. `task` is included because `disallowedTools` applies
 * only to the main loop — subagents keep their own toolset and could still
 * call `askQuestion`.
 */
export const CURSOR_DISALLOWED_TOOLS: Array<'askQuestion' | 'await' | 'task'> = ['askQuestion', 'await', 'task'];

const DEFAULT_MODEL = 'composer-2.5';
const STALE_SESSION_RE = /agent not found|unknown agent|no conversation|session.*not found/i;
const ACTIVE_RUN_RE = /already has (?:an )?active run/i;
const MEMORY_HOOK_COMMAND = 'bun /app/src/providers/cursor-hook.ts';

/**
 * SDK entry points, overridable in unit tests so a fake Agent can drive
 * event mapping without `mock.module` leaking into the barrel registration test.
 */
export const cursorAgentApi = {
  create: async (options: AgentOptions) => (await loadCursorSdk()).Agent.create(options),
  resume: async (agentId: string, options: AgentOptions) => (await loadCursorSdk()).Agent.resume(agentId, options),
};

function log(msg: string): void {
  console.error(`[cursor-provider] ${msg}`);
}

function cursorHome(): string {
  return path.join(process.env.HOME || os.homedir(), '.cursor');
}

function agentRoot(): string {
  return process.env.NANOCLAW_AGENT_DIR || '/workspace/agent';
}

export function mapMcpServers(servers: Record<string, McpServerConfig>): Record<string, CursorMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if (server.type === 'http') {
        return [name, { type: 'http' as const, url: server.url, headers: server.headers ?? {} }];
      }
      return [
        name,
        {
          type: 'stdio' as const,
          command: server.command,
          args: server.args ?? [],
          env: server.env ?? {},
          ...(server.cwd ? { cwd: server.cwd } : {}),
        },
      ];
    }),
  );
}

export function extractAssistantText(event: SDKMessage): string {
  if (event.type !== 'assistant') return '';
  const blocks = event.message?.content ?? [];
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export function toolProgressMessage(event: SDKMessage): string | null {
  if (event.type !== 'tool_call') return null;
  const name = event.name || 'tool';
  if (event.status === 'running') return `${name}…`;
  if (event.status === 'error') return `${name} failed`;
  return null;
}

export async function* waitForRunWithActivity(
  run: Pick<Run, 'wait'>,
  heartbeatMs = 15_000,
): AsyncGenerator<ProviderEvent, RunResult> {
  type WaitOutcome = { result: RunResult } | { error: unknown };
  const completion: Promise<WaitOutcome> = run.wait().then(
    (result): WaitOutcome => ({ result }),
    (error: unknown): WaitOutcome => ({ error }),
  );

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), heartbeatMs);
    });
    const outcome = await Promise.race([completion, heartbeat]);
    if (outcome === null) {
      yield { type: 'activity' };
      continue;
    }
    if (timer) clearTimeout(timer);
    if ('error' in outcome) throw outcome.error;
    return outcome.result;
  }
}

interface CursorHooksDocument {
  version?: unknown;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

function readHooksDocument(filePath: string): CursorHooksDocument | null {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as CursorHooksDocument;
    log(`Leaving non-object Cursor hooks document unchanged at ${filePath}`);
  } catch (err) {
    log(`Leaving malformed Cursor hooks document unchanged at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function mergeMemoryHook(filePath: string): void {
  const payload = readHooksDocument(filePath);
  if (!payload) return;
  const hooks =
    payload.hooks && typeof payload.hooks === 'object' && !Array.isArray(payload.hooks) ? payload.hooks : {};
  const addHook = (name: string, command: string): void => {
    const existing = Array.isArray(hooks[name]) ? hooks[name] : [];
    hooks[name] = [
      ...existing.filter(
        (entry) =>
          !entry ||
          typeof entry !== 'object' ||
          !('command' in entry) ||
          (entry as { command?: unknown }).command !== command,
      ),
      { command },
    ];
  };

  addHook('sessionStart', MEMORY_HOOK_COMMAND);
  addHook('preCompact', `${MEMORY_HOOK_COMMAND} --compact`);
  payload.version = 1;
  payload.hooks = hooks;
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function writeMemoryHooks(): void {
  const projectDir = path.join(agentRoot(), '.cursor');
  fs.mkdirSync(projectDir, { recursive: true });
  mergeMemoryHook(path.join(projectDir, 'hooks.json'));

  const userDir = cursorHome();
  fs.mkdirSync(userDir, { recursive: true });
  mergeMemoryHook(path.join(userDir, 'hooks.json'));
}

function archiveExchange(exchange: ProviderExchange, assistantName?: string): void {
  if (!exchange.prompt && !exchange.result) return;
  const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
  try {
    fs.mkdirSync(conversationsDir, { recursive: true });
    const stamp = formatLocalStamp(new Date(), TIMEZONE);
    const filenameBase = `${stamp.slice(0, 10)}-${stamp.slice(11, 13)}${stamp.slice(14, 16)}${stamp.slice(17, 19)}-cursor`;
    const sender = assistantName || 'Assistant';
    const body = [
      `# Conversation`,
      '',
      `Archived: ${stamp}`,
      '',
      '---',
      '',
      `**User**: ${exchange.prompt}`,
      '',
      `**${sender}**: ${exchange.result ?? '(no result)'}`,
      '',
    ].join('\n');
    for (let suffix = 1; ; suffix += 1) {
      const filename = suffix === 1 ? `${filenameBase}.md` : `${filenameBase}-${suffix}.md`;
      try {
        fs.writeFileSync(path.join(conversationsDir, filename), body, { flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
    }
  } catch (err) {
    log(`Failed to archive exchange: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export class CursorProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly emitsMidTurnText = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private additionalDirectories?: string[];
  private model?: string;
  private memorySessionHook?: MemorySessionHookRegistration;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    writeMemoryHooks();
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    if (err instanceof Error && err.name === 'AgentNotFoundError') return true;
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  onExchangeComplete(exchange: ProviderExchange): void {
    archiveExchange(exchange, this.assistantName);
  }

  private agentOptions(cwd: string): AgentOptions {
    return {
      apiKey: CURSOR_API_KEY_PLACEHOLDER,
      name: this.assistantName,
      model: { id: this.model || DEFAULT_MODEL },
      mcpServers: mapMcpServers(this.mcpServers),
      disallowedTools: [...CURSOR_DISALLOWED_TOOLS],
      local: {
        cwd,
        dirs: this.additionalDirectories,
        // Project + user layers. Container HOME is the per-group `.cursor-shared`
        // mount, not a desktop Cursor install, so `"user"` loads persistent
        // ~/.cursor/skills and hooks.json. Inline MCP still wins.
        // sessionStart additional_context is fire-and-forget in Cursor and often
        // never reaches the model — memory is also prepended on the first send.
        settingSources: ['project', 'user'],
        sandboxOptions: { enabled: false },
      },
    };
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Cursor memory session hook was not registered');

    let aborted = false;
    let currentRun: Run | null = null;
    let cancelPromise: Promise<void> | null = null;
    let acceptingInput = true;
    const pendingPrompts = [input.prompt];
    const options = this.agentOptions(input.cwd);
    const isInvalidSession = (err: unknown): boolean => this.isSessionInvalid(err);
    let injectedMemory = false;
    const withSystemInstructions = (prompt: string): string => {
      const parts: string[] = [];
      if (input.systemContext?.instructions) parts.push(input.systemContext.instructions);
      // Cursor's sessionStart hook is documented as fire-and-forget; live runs
      // confirm additional_context does not land in the model. Prepend the
      // shared memory index on the first send of a new session. Resumes already
      // have that context, and follow-up pushes skip it.
      if (!injectedMemory) {
        const memory = memoryContextForSessionStart(input.continuation ? 'resume' : 'startup', input.cwd);
        if (memory) parts.push(memory);
        injectedMemory = true;
      }
      parts.push(prompt);
      return parts.join('\n\n');
    };

    const cancelCurrentRun = (): Promise<void> => {
      if (!currentRun?.supports('cancel')) return Promise.resolve();
      if (cancelPromise) return cancelPromise;
      try {
        cancelPromise = currentRun.cancel().catch((err) => {
          log(`Failed to cancel run: ${err instanceof Error ? err.message : String(err)}`);
        });
      } catch (err) {
        log(`Failed to cancel run: ${err instanceof Error ? err.message : String(err)}`);
        cancelPromise = Promise.resolve();
      }
      return cancelPromise;
    };

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let agent: Awaited<ReturnType<(typeof cursorAgentApi)['create']>> | null = null;
      try {
        agent = input.continuation
          ? await cursorAgentApi.resume(input.continuation, options)
          : await cursorAgentApi.create(options);

        if (aborted) return;
        yield { type: 'init', continuation: agent.agentId };

        while (!aborted && pendingPrompts.length > 0) {
          const prompt = pendingPrompts.shift()!;
          yield { type: 'activity' };
          if (aborted) return;

          const preparedPrompt = withSystemInstructions(prompt);
          let run: Run;
          try {
            run = await agent.send(preparedPrompt);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!ACTIVE_RUN_RE.test(message)) throw err;
            log('Expiring stale active Cursor run and retrying the message');
            run = await agent.send(preparedPrompt, { local: { force: true } });
          }
          currentRun = run;
          cancelPromise = null;
          if (aborted) {
            await cancelCurrentRun();
            return;
          }

          let streamed = '';
          if (run.supports('stream')) {
            for await (const event of run.stream()) {
              if (aborted) {
                await cancelCurrentRun();
                return;
              }
              yield { type: 'activity' };
              const text = extractAssistantText(event);
              streamed += text;
              if (text) yield { type: 'text', text };
              const progress = toolProgressMessage(event);
              if (progress) yield { type: 'progress', message: progress };
            }
          }

          const waitEvents = waitForRunWithActivity(run);
          let result: RunResult;
          while (true) {
            const next = await waitEvents.next();
            if (next.done) {
              result = next.value;
              break;
            }
            if (aborted) {
              await cancelCurrentRun();
              return;
            }
            yield next.value;
          }
          currentRun = null;
          cancelPromise = null;
          if (aborted) return;

          if (result.status === 'cancelled') {
            yield { type: 'error', message: 'Cancelled', retryable: false };
            yield { type: 'result', text: 'Cancelled', isError: true };
            return;
          } else if (result.status === 'error') {
            const text = result.error?.message || result.result || streamed || 'Cursor run failed';
            yield { type: 'result', text, isError: true };
          } else {
            yield { type: 'result', text: result.result ?? (streamed || null) };
          }
        }
      } catch (err) {
        if (aborted) return;
        if (input.continuation && isInvalidSession(err)) throw err;
        const { CursorAgentError } = await loadCursorSdk();
        if (err instanceof CursorAgentError) {
          yield {
            type: 'error',
            message: err.message,
            retryable: err.isRetryable,
            classification: err.code,
          };
          yield { type: 'result', text: err.message, isError: true };
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        yield {
          type: 'error',
          message,
          retryable: false,
        };
        yield { type: 'result', text: message, isError: true };
      } finally {
        acceptingInput = false;
        currentRun = null;
        try {
          agent?.close();
        } catch (err) {
          log(`Failed to close agent: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return {
      push(message) {
        if (acceptingInput && !aborted) pendingPrompts.push(message);
      },
      end() {
        acceptingInput = false;
      },
      events: translateEvents(),
      abort() {
        aborted = true;
        void cancelCurrentRun();
      },
    };
  }
}

registerProvider('cursor', (opts) => new CursorProvider(opts));
