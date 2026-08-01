/** Maximum structured CLI input accepted from stdin (64 KiB, measured as UTF-8 bytes). */
export const MAX_STDIN_JSON_BYTES = 64 * 1024;

export type StdinJsonStream = AsyncIterable<string | Uint8Array>;

/** Expected validation failure caused by the contents of `--stdin-json`. */
export class StdinJsonInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StdinJsonInputError';
  }
}

/** Match the key normalization applied by command parsers in crud.ts. */
function canonicalArgKey(key: string): string {
  return key.replace(/-/g, '_');
}

/**
 * Read one bounded JSON object from stdin and merge it with argv-derived args.
 * A key may come from exactly one source so shell-visible flags cannot be
 * silently replaced by piped data.
 */
export async function readStdinJsonArgs(
  stream: StdinJsonStream,
  argvArgs: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_STDIN_JSON_BYTES) {
      throw new StdinJsonInputError(`--stdin-json input exceeds ${MAX_STDIN_JSON_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  const source = Buffer.concat(chunks, byteLength).toString('utf8');
  if (source.trim().length === 0) {
    throw new StdinJsonInputError('--stdin-json input is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new StdinJsonInputError('--stdin-json input is not valid JSON', { cause: err });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StdinJsonInputError('--stdin-json input must be one JSON object');
  }

  const stdinArgs = parsed as Record<string, unknown>;
  const argvKeysByCanonical = new Map<string, string>();
  for (const key of Object.keys(argvArgs)) {
    const canonical = canonicalArgKey(key);
    if (!argvKeysByCanonical.has(canonical)) argvKeysByCanonical.set(canonical, key);
  }

  const stdinKeysByCanonical = new Map<string, string>();
  for (const key of Object.keys(stdinArgs)) {
    if (key === '__proto__') {
      throw new StdinJsonInputError('--stdin-json key "__proto__" is not allowed');
    }

    if (Object.prototype.hasOwnProperty.call(argvArgs, key)) {
      throw new StdinJsonInputError(`--stdin-json key "${key}" is also supplied on argv`);
    }

    const canonical = canonicalArgKey(key);
    const argvKey = argvKeysByCanonical.get(canonical);
    if (argvKey !== undefined) {
      throw new StdinJsonInputError(
        `--stdin-json key "${key}" conflicts with argv key "${argvKey}" after CLI key normalization`,
      );
    }

    const priorStdinKey = stdinKeysByCanonical.get(canonical);
    if (priorStdinKey !== undefined) {
      throw new StdinJsonInputError(
        `--stdin-json keys "${priorStdinKey}" and "${key}" conflict after CLI key normalization`,
      );
    }
    stdinKeysByCanonical.set(canonical, key);
  }

  return Object.fromEntries([...Object.entries(argvArgs), ...Object.entries(stdinArgs)]);
}
