import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';

import { createOpencodeClient, type FilePartInput, type OpencodeClient } from '@opencode-ai/sdk';
// The root `@opencode-ai/sdk` client (pinned ^1.4.3, resolves 1.4.11 on this
// branch) has no `.question` surface at all — reply/reject/list for the
// interactive `question` tool only exist on the `/v2` subpath client (present
// in both 1.4.11 and 1.4.17; verified via `npm pack` .d.ts). Import it
// separately so the session/event client above is untouched.
import { createOpencodeClient as createOpencodeQuestionClient } from '@opencode-ai/sdk/v2';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  PromptAttachment,
  ProviderOptions,
  QueryInput,
} from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { getAllDestinations } from '../destinations.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

// The input modalities OpenCode's config schema accepts on a model entry
// (@opencode-ai/sdk types.gen.d.ts `modalities.input`). Anything outside this
// set makes OpenCode reject the whole config, so operator input is validated
// against it rather than passed through.
const MODEL_INPUT_MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'] as const;

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function spawnOpencodeServer(config: Record<string, unknown>, timeoutMs = 10_000): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const port = 4096;
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      detached: true,
    });

    const id = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

/** Extension → MIME fallback, for adapters that report no `mimeType`. */
const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
};

function attachmentMime(att: PromptAttachment): string | undefined {
  if (att.mime) return att.mime;
  const name = att.path || att.filename || '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : ATTACHMENT_MIME_BY_EXT[name.slice(dot).toLowerCase()];
}

/**
 * Turn a turn's attachments into OpenCode file parts, so the model sees the
 * media itself rather than only the `[image: cat.png — saved to …]` line the
 * formatter already renders into the prompt text.
 *
 * The URL is a `file://` path, NOT a data: URI, deliberately: OpenCode resolves
 * a file: part server-side — packages/opencode/src/session/prompt.ts (v1.4.14)
 * `case "file:"` at :1043 does `fileURLToPath(part.url)` at :1045 and, for a
 * mime that is neither text/plain nor a directory, re-emits the part as
 * `data:${part.mime};base64,` + the file it read (:1197-1199). Base64-ing here
 * would only duplicate that work and inflate the request body. The server
 * shares this container's filesystem (spawnOpencodeServer), so the path resolves.
 *
 * Only images and PDFs are forwarded; PDFs go through even though a given
 * backend may reject them, since the alternative is silently withholding a
 * document the user did send. Anything skipped is still described in the
 * prompt text, so it is never lost — just not handed over as media.
 *
 * `exists` is injectable so tests can drive resolvability without touching disk.
 */
export function buildAttachmentFileParts(
  attachments: PromptAttachment[] | undefined,
  exists: (path: string) => boolean = existsSync,
): FilePartInput[] {
  const parts: FilePartInput[] = [];
  for (const att of attachments ?? []) {
    const mime = attachmentMime(att);
    if (!mime) continue;
    if (!mime.startsWith('image/') && mime !== 'application/pdf') continue;
    if (!att.path || !exists(att.path)) {
      const label = att.filename || att.path || att.url || 'unnamed';
      log(`Attachment has no readable local file, not sent as media: ${label}`);
      continue;
    }
    parts.push({ type: 'file', mime, filename: att.filename, url: pathToFileURL(att.path).href });
  }
  return parts;
}

/**
 * The prompt body for one turn: the text the formatter produced, plus any
 * media that came with it. Both the opening prompt and every mid-turn push go
 * through here, so an attachment reaches the model the same way whichever path
 * carried it — OpenCode holds one query open per session, so in practice most
 * real messages arrive as pushes.
 */
export function buildPromptParts(
  text: string,
  attachments?: PromptAttachment[],
  exists: (path: string) => boolean = existsSync,
): Array<{ type: 'text'; text: string } | FilePartInput> {
  return [{ type: 'text', text }, ...buildAttachmentFileParts(attachments, exists)];
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

export function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);

  // OpenCode auto-compacts a session once tokens >= limit.context - maxOutputTokens.
  // Undeclared custom models resolve limit.context to 0, which silently disables
  // compaction and kills long sessions against a fixed-window backend (e.g. vLLM).
  // Absent these env vars, behavior is unchanged (no `limit` key emitted).
  const contextLimitEnv = process.env.OPENCODE_MODEL_CONTEXT_LIMIT;
  const outputLimitEnv = process.env.OPENCODE_MODEL_OUTPUT_LIMIT;
  const modelLimit =
    contextLimitEnv !== undefined
      ? {
          context: Number(contextLimitEnv),
          ...(outputLimitEnv !== undefined ? { output: Number(outputLimitEnv) } : {}),
        }
      : undefined;

  // OpenCode drops every non-text file part whose modality the model does not
  // declare: provider/transform.ts:292 (v1.4.14) keeps a part only when
  // `model.capabilities.input[modality]` is true, and otherwise substitutes
  // `ERROR: Cannot read … (this model does not support <modality> input)`.
  // A registry-unknown custom model resolves each of those flags to false
  // (provider/provider.ts:1154-1158), so an image reaches the session store but
  // never the model — live-confirmed on a vLLM-hosted model, which answered
  // that it does not support image input while the prompt carried zero image
  // tokens. Declaring the modalities is the only thing that opens that gate;
  // `attachment` is a registry/UI flag rather than a pipeline gate, but it is
  // set alongside so the entry stays internally consistent.
  // Absent this env var, behavior is unchanged (no capability keys emitted).
  const modalityEnv = process.env.OPENCODE_MODEL_INPUT_MODALITIES;
  const requestedModalities = (modalityEnv ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .filter((entry, i, a) => a.indexOf(entry) === i)
    .filter((entry) => {
      if ((MODEL_INPUT_MODALITIES as readonly string[]).includes(entry)) return true;
      log(`Ignoring unknown OPENCODE_MODEL_INPUT_MODALITIES entry: ${entry}`);
      return false;
    })
    .filter((entry) => entry !== 'text');
  const modelModalities =
    requestedModalities.length > 0
      ? { input: ['text', ...requestedModalities], output: ['text'] }
      : undefined;

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            // A custom base URL on the `openai` provider means a self-hosted
            // OpenAI-compatible endpoint (vLLM, llama.cpp, …). The stock openai
            // SDK package speaks the Responses API, whose multi-turn history
            // vLLM rejects (assistant items lack id/status) — pin the Chat
            // Completions transport. Scoped to `openai` only: other providers
            // (e.g. `openrouter`, set alongside ANTHROPIC_BASE_URL per the
            // documented OpenRouter config) ship their own native ai-sdk
            // package and must keep OpenCode's default transport resolution.
            ...(provider === 'openai' && proxyUrl ? { npm: '@ai-sdk/openai-compatible' } : {}),
            options: { apiKey: 'placeholder', baseURL: proxyUrl },
            ...(modelsToRegister.length > 0
              ? {
                  models: Object.fromEntries(
                    modelsToRegister.map((mid) => [
                      mid,
                      {
                        id: mid,
                        name: mid,
                        tool_call: true,
                        ...(modelLimit ? { limit: modelLimit } : {}),
                        ...(modelModalities ? { attachment: true, modalities: modelModalities } : {}),
                      },
                    ]),
                  ),
                }
              : {}),
          },
        };

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // Load the shared base + per-group fragments through OpenCode's native
  // instructions pipeline (session/instruction.ts). Absolute paths with
  // globs are supported. Files are read raw — `@./...` includes are NOT expanded
  // by OpenCode, so point at the concrete files, not at composed CLAUDE.md.
  //
  // Memory deliberately does NOT ride this array. OpenCode's instruction
  // pipeline calls instruction.system() on every model request and rereads
  // each file raw, so memory files listed here would be re-read (uncapped,
  // unrendered) on every request instead of following the shared
  // startup/clear/compact lifecycle. Memory is delivered by the registered
  // memory session hook instead — see createMemoryLifecycle below.
  const instructions = [
    '/app/CLAUDE.md',
    '/workspace/agent/.claude-fragments/*.md',
    '/workspace/agent/CLAUDE.local.md',
  ];

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    // A flat `permission: 'allow'` string leaves every category — including
    // `question`, OpenCode's built-in interactive multi-choice tool — to
    // whatever OpenCode's own default/merge resolves it to. Server logs from
    // a live session showed that resolution land on BOTH `question -> deny *`
    // and `question -> allow *` for the same session: internally
    // contradictory, and whichever rule wins last, `allow` sometimes does —
    // and a headless container has no human to answer an interactive
    // question, so any path that lets it fire wedges the session forever
    // (see OpenCodeProvider's question.asked handling below for the runtime
    // belt-and-suspenders). Enumerate every known permission category
    // explicitly instead of relying on the wildcard string, so `question`
    // resolves to a single deterministic value — `deny` — that can never
    // contradict itself, while every other category keeps the prior
    // "allow everything" behavior.
    permission: {
      read: 'allow',
      edit: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      bash: 'allow',
      task: 'allow',
      external_directory: 'allow',
      todowrite: 'allow',
      question: 'deny',
      webfetch: 'allow',
      websearch: 'allow',
      codesearch: 'allow',
      lsp: 'allow',
      doom_loop: 'allow',
      skill: 'allow',
    },
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    instructions,
    mcp,
  };
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  questionClient: QuestionClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const questionClient = createOpencodeQuestionClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    // Belt-and-suspenders drain before this runtime serves any turn — see
    // drainPendingQuestions doc comment.
    await drainPendingQuestions(questionClient);
    sharedRuntime = {
      proc,
      client,
      questionClient,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killProcessTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

// Steers the model rather than just silently declining: nothing in this
// container can answer an interactive question, so tell it to decide on its
// own or fall back to nanoclaw's own blocking MCP tool (mcp-tools/interactive.ts,
// registered as `ask_user_question`), which actually reaches the human through
// the chat channel instead of OpenCode's headless-dead-end question tool.
export const QUESTION_STEERING_TEXT =
  'Interactive questions are not available in this environment. Decide autonomously based on your best judgment, or use the ask_user_question MCP tool to ask the human through the chat channel.';

/**
 * Routing-discipline reminder injected on the first prompt AFTER OpenCode
 * auto-compacts the active session. Compaction rewrites the transcript into a
 * summary, and the delivery contract — every reply that should reach a human
 * must be wrapped in <message to="name">…</message> blocks, which the poll-loop
 * enforces when it dispatches the agent's final text — is exactly the kind of
 * standing instruction a summary can quietly drop. Once it is gone, replies
 * stop reaching anyone. Re-state it, with the live destination list, so the
 * next turn routes correctly.
 *
 * OpenCode 1.4.11 (the pinned SDK) exposes no compaction-prompt /
 * customInstructions API — the Config type has no such key and session
 * summarization takes only providerID + modelID — so unlike the Claude
 * provider's PreCompact hook we cannot steer the summary itself. We re-inject
 * on the next prompt instead. Destinations are read fresh at injection time.
 *
 * NB: on this providers branch there is no shared buildCompactInstructions()
 * helper to reuse (it and the task-series model it depends on land far ahead on
 * main), so this reminder states the branch's own <message to> discipline
 * rather than importing text that does not exist here.
 */
export function buildPostCompactionReminder(names: string[] = getAllDestinations().map((d) => d.name)): string {
  const list = names.length > 0 ? names.map((n) => `\`${n}\``).join(', ') : '(none)';
  return (
    '<system>The conversation was just compacted into a summary. Routing instructions can be lost in ' +
    'that summary, so as a reminder: wrap every reply you want delivered in ' +
    '<message to="name">…</message> blocks — text outside such blocks is treated as scratchpad and is ' +
    `NOT sent. Available destinations: ${list}.</system>`
  );
}

/**
 * Per-query compaction-reminder latch. `note` arms it when a
 * `session.compacted` event names the turn's active session — the OpenCode
 * server is shared across sessions, so an unrelated session's compaction must
 * never arm this query's reminder. `apply` prepends the reminder to the next
 * prompt exactly once, then disarms. `buildReminder` is injectable so tests can
 * drive the latch without touching the destinations DB.
 */
export function createCompactionReminder(buildReminder: () => string = buildPostCompactionReminder): {
  note(eventSessionId: string | undefined, activeSessionId: string | undefined): void;
  apply(message: string): string;
  readonly isArmed: boolean;
} {
  let armed = false;
  return {
    note(eventSessionId, activeSessionId) {
      if (activeSessionId !== undefined && eventSessionId === activeSessionId) armed = true;
    },
    apply(message) {
      if (!armed) return message;
      armed = false;
      return `${buildReminder()}\n\n${message}`;
    },
    get isArmed() {
      return armed;
    },
  };
}

/**
 * Structural mirror of the runner's `MemorySessionHookRegistration`
 * (`container/agent-runner/src/memory/session-hook.ts`). Declared locally for
 * the same reason `codex-app-server.ts` declares `CodexMemorySessionHook`: this
 * providers branch carries no `src/memory/*`, so importing the real type would
 * not compile here, while a structural copy still satisfies the interface once
 * this payload is installed onto a main-based tree. The command is referenced
 * by string and executed as a subprocess — never imported — so the rendering
 * and the 16k/file caps stay inside the shared hook.
 */
export interface OpenCodeMemorySessionHook {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

/**
 * The two lifecycle points at which this provider establishes a new context
 * window. `clear` never appears: OpenCode has no in-session clear — a cleared
 * conversation arrives as a fresh session, i.e. `startup`. `resume` never
 * appears either, by contract: memory is not re-injected when an existing
 * session continues.
 */
export type OpenCodeMemorySource = 'startup' | 'compact';

/** Matches the `timeout: 10` (seconds) the Claude provider registers for the same command. */
const MEMORY_HOOK_TIMEOUT_MS = 10_000;

/**
 * Run the registered memory session hook and return what it printed.
 *
 * The hook reads a Claude-style SessionStart payload on stdin and prints the
 * rendered memory section on stdout (`src/memory/hook.ts`), which is where the
 * per-file caps and the "resume gets nothing" rule live. Nothing is capped or
 * rewritten here — whatever the command prints is what gets injected.
 *
 * Fails closed on every failure mode (unregistered, source the registration
 * does not declare, missing command, non-zero exit, timeout, empty stdout):
 * one log line, no injection, never a thrown turn.
 */
export function runMemorySessionHook(
  hook: OpenCodeMemorySessionHook | undefined,
  source: OpenCodeMemorySource,
): string | undefined {
  if (!hook) {
    log(`No memory session hook registered; skipping ${source} memory injection`);
    return undefined;
  }
  if (!hook.sources.includes(source)) {
    log(`Memory session hook does not declare source ${source}; skipping injection`);
    return undefined;
  }

  try {
    const res = spawnSync(hook.command, {
      shell: true,
      input: JSON.stringify({ hook_event_name: 'SessionStart', source }),
      encoding: 'utf-8',
      timeout: MEMORY_HOOK_TIMEOUT_MS,
    });
    if (res.error || res.status !== 0) {
      const why = res.error ? res.error.message : `exit ${String(res.status)}`;
      log(`Memory session hook (${source}) failed (${why}); continuing without memory`);
      return undefined;
    }
    const out = (res.stdout ?? '').trim();
    if (!out) {
      log(`Memory session hook (${source}) produced no output; continuing without memory`);
      return undefined;
    }
    return out;
  } catch (err) {
    log(`Memory session hook (${source}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Per-query memory lifecycle. One instance per `query()`, mirroring
 * createCompactionReminder, so nothing leaks between queries.
 *
 * `openingInstructions` covers the new-context case: an opening query with no
 * continuation is a brand-new OpenCode session (a fresh container and a cleared
 * conversation both land here), so memory joins the system instructions that
 * prompt already carries — exactly one memory block per context window, since
 * follow-up pushes re-send the plain instructions. A query that resumes a
 * continuation passes the instructions through untouched and never runs the
 * command at all.
 *
 * `pushPrefix` covers the other place a context window is rebuilt: OpenCode
 * auto-compaction. The caller passes the compaction latch's armed state, so
 * memory rides the same exactly-once next-prompt slot as the routing reminder.
 */
export function createMemoryLifecycle(
  hook: OpenCodeMemorySessionHook | undefined,
  isResume: boolean,
): {
  openingInstructions(systemInstructions?: string): string | undefined;
  pushPrefix(justCompacted: boolean): string;
} {
  return {
    openingInstructions(systemInstructions) {
      if (isResume) return systemInstructions;
      const memory = runMemorySessionHook(hook, 'startup');
      if (!memory) return systemInstructions;
      return systemInstructions ? `${memory}\n\n${systemInstructions}` : memory;
    },
    pushPrefix(justCompacted) {
      if (!justCompacted) return '';
      const memory = runMemorySessionHook(hook, 'compact');
      return memory ? `${memory}\n\n` : '';
    },
  };
}

/**
 * Minimal shape of the `/v2` SDK surface this module needs for question
 * handling — narrowed so tests can pass a fake without pulling in the real
 * `@opencode-ai/sdk/v2` client.
 */
export interface QuestionClient {
  question: {
    reply(params: { requestID: string; answers: string[][] }): Promise<{ data?: unknown; error?: unknown }>;
    list(): Promise<{ data?: Array<{ id: string; sessionID?: string; questions?: unknown[] }>; error?: unknown }>;
  };
}

/**
 * Answer a single pending question request with the steering text, one
 * custom answer per sub-question (OpenCode's `question` tool defaults
 * `custom: true`, i.e. an answer string that isn't one of the offered
 * option labels is accepted as free text). Never throws — a failed
 * auto-answer should not take down the session any more than the question
 * already threatened to.
 */
export async function autoAnswerQuestion(
  questionClient: QuestionClient,
  req: { id?: string; questions?: unknown[] },
): Promise<void> {
  if (!req.id) return;
  const count = Array.isArray(req.questions) && req.questions.length > 0 ? req.questions.length : 1;
  try {
    const res = await questionClient.question.reply({
      requestID: req.id,
      answers: Array.from({ length: count }, () => [QUESTION_STEERING_TEXT]),
    });
    if (res.error) {
      log(`Failed to auto-answer question ${req.id}: ${JSON.stringify(res.error)}`);
    }
  } catch (err) {
    log(`Failed to auto-answer question ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Defensive belt: drain any question requests already pending when a shared
 * runtime comes up (e.g. one that raced the event subscription, or survived
 * from a prior server instance) so none of them can sit there wedging future
 * turns before the event-driven handler ever sees them.
 */
export async function drainPendingQuestions(questionClient: QuestionClient): Promise<void> {
  try {
    const res = await questionClient.question.list();
    if (res.error) {
      log(`Failed to list pending questions: ${JSON.stringify(res.error)}`);
      return;
    }
    for (const req of res.data ?? []) {
      await autoAnswerQuestion(questionClient, req);
    }
  } catch (err) {
    log(`Failed to list pending questions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;
  private memorySessionHook?: OpenCodeMemorySessionHook;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  // OpenCode has no native session-start hook mechanism to hand the command to
  // (as the Claude Agent SDK's settings.json and Codex's hooks.json have), so
  // the provider stores the registration and runs the command itself at the
  // lifecycle points OpenCode does expose — see createMemoryLifecycle.
  registerMemorySessionHook(hook: OpenCodeMemorySessionHook): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    // Same refusal as the Codex provider: the runner registers the shared hook
    // unconditionally before polling, so an unregistered provider means the
    // wiring broke — fail loudly rather than run a memoryless agent forever.
    if (!this.memorySessionHook) throw new Error('OpenCode memory session hook was not registered');

    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: Array<{ text: string; attachments?: PromptAttachment[] }> = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    // Latch that re-injects the routing reminder on the next prompt after the
    // active session auto-compacts (see createCompactionReminder). Per-query so
    // it never leaks a pending reminder across independent query() calls.
    const compaction = createCompactionReminder();
    // Memory rides the same two moments a context window is (re)built: this
    // opening prompt when it starts a new session, and the first prompt after
    // a compaction. Never on a resume, never on an ordinary push.
    const memory = createMemoryLifecycle(this.memorySessionHook, Boolean(input.continuation));

    const systemInstructions = input.systemContext?.instructions;
    pending.push({
      text: wrapPromptWithContext(input.prompt, memory.openingInstructions(systemInstructions)),
      attachments: input.attachments,
    });

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 300_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream, questionClient } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const { text, attachments } = pending.shift()!;
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: buildPromptParts(text, attachments) },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        const partTextByMessageId = new Map<string, string>();
        const roleByMessageId = new Map<string, string>();
        let lastEventAt = Date.now();
        let eventTimedOut = false;
        const timeoutCheck = setInterval(() => {
          if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
            log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
            eventTimedOut = true;
            self.activeSessionId = undefined;
            destroySharedRuntime();
            kick();
          }
        }, 5000);

        try {
          turn: while (true) {
            if (aborted) return;
            if (eventTimedOut) {
              throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
            }

            const { value: ev, done } = await stream.next();
            if (done) {
              throw new Error('OpenCode SSE stream ended unexpectedly');
            }

            if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

            lastEventAt = Date.now();
            yield { type: 'activity' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as { id?: string; role?: string } | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as { type?: string; messageID?: string; text?: string } | undefined;
                if (part?.type === 'text' && part.messageID && part.text) {
                  partTextByMessageId.set(part.messageID, part.text);
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'question.asked': {
                // The `question: 'deny'` config above should stop this tool
                // from ever firing, but this is the real fix for the wedge:
                // whatever raises this event, answer it immediately so the
                // single shared OpenCode server can never block on it — a
                // config regression or an OpenCode-side path that raises the
                // event before consulting permission should not be able to
                // freeze every subsequent turn again.
                const req = ev.properties as { id?: string; sessionID?: string; questions?: unknown[] };
                if (req.sessionID === undefined || req.sessionID === sessionId) {
                  await autoAnswerQuestion(questionClient, req);
                }
                break;
              }
              case 'session.status': {
                const props = ev.properties as {
                  sessionID?: string;
                  status?: { type?: string; attempt?: number; message?: string };
                };
                if (props.sessionID !== sessionId) break;
                const st = props.status;
                if (
                  st?.type === 'retry' &&
                  typeof st.attempt === 'number' &&
                  st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                  st.message
                ) {
                  self.activeSessionId = undefined;
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  self.activeSessionId = undefined;
                  throw new Error(sessionErrorMessage(props));
                }
                break;
              }
              case 'session.compacted': {
                // The active session was just auto-compacted; arm the routing
                // reminder for the next prompt. Filter by sessionID like the
                // other cases — the shared server emits this for every session.
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                compaction.note(sid, sessionId);
                break;
              }
              case 'session.idle': {
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                if (sid === sessionId) {
                  break turn;
                }
                break;
              }
              default:
                break;
            }
          }
        } finally {
          clearInterval(timeoutCheck);
        }

        let resultText = '';
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant') {
            resultText = partTextByMessageId.get(msgId) ?? resultText;
          }
        }
        yield { type: 'result', text: resultText || null };
      }
    }

    return {
      push: (message: string, attachments?: PromptAttachment[]) => {
        // If the active session compacted mid-conversation, memory and the
        // routing reminder both ride this next prompt (once each), then the
        // latch disarms. Read the latch BEFORE apply() consumes it. Order is
        // memory, then reminder, then the user's text.
        const justCompacted = compaction.isArmed;
        pending.push({
          text: wrapPromptWithContext(memory.pushPrefix(justCompacted) + compaction.apply(message), systemInstructions),
          attachments,
        });
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
