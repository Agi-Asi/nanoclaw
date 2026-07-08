/**
 * Post-write hook contract: hooks observe the LOG (fire only after a
 * successful append, exported ⊆ written), failures are isolated everywhere,
 * and the lifecycle (init/maintain/shutdown) behaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: true, appendThrows: false, appended: [] as string[] }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-hooks-unused',
  };
});

vi.mock('./config.js', () => ({
  get AUDIT_ENABLED() {
    return state.enabled;
  },
  AUDIT_RETENTION_DAYS: 90,
}));

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.js')>();
  return {
    ...actual,
    appendAuditLine: (line: string) => {
      if (state.appendThrows) throw new Error('disk full');
      state.appended.push(line);
    },
  };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let hooks: typeof import('./hooks.js');
let emit: typeof import('./emit.js');
let log: (typeof import('../log.js'))['log'];

beforeEach(async () => {
  state.enabled = true;
  state.appendThrows = false;
  state.appended.length = 0;
  vi.resetModules(); // fresh hook registry per test
  hooks = await import('./hooks.js');
  emit = await import('./emit.js');
  log = (await import('../log.js')).log;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

const EVENT_INPUT = {
  actor: { type: 'human' as const, id: 'host:test' },
  origin: { transport: 'socket' as const },
  action: 'groups.list',
  resources: [{ type: 'agent_group' }],
  outcome: 'success' as const,
  details: { limit: 5 },
};

describe('post-write notification', () => {
  it('calls a registered hook with the parsed event and the exact stored line', () => {
    const seen: Array<{ event: import('./types.js').AuditEvent; line: string }> = [];
    hooks.registerAuditHook({ name: 'demo', onEvent: (event, line) => seen.push({ event, line }) });

    emit.emitAuditEvent(EVENT_INPUT);

    expect(state.appended).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].line).toBe(state.appended[0]);
    expect(JSON.parse(seen[0].line)).toEqual(seen[0].event);
    expect(seen[0].event.action).toBe('groups.list');
  });

  it('does NOT call hooks when the local append fails — exported ⊆ written', () => {
    const onEvent = vi.fn();
    hooks.registerAuditHook({ name: 'demo', onEvent });
    state.appendThrows = true;

    expect(() => emit.emitAuditEvent(EVENT_INPUT)).not.toThrow(); // action still proceeds
    expect(onEvent).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Audit append failed'), expect.anything());
  });

  it('does NOT call hooks when audit is disabled', () => {
    const onEvent = vi.fn();
    hooks.registerAuditHook({ name: 'demo', onEvent });
    state.enabled = false;

    emit.emitAuditEvent(EVENT_INPUT);

    expect(state.appended).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('isolates a throwing hook: the write survives, later hooks still run, the action proceeds', () => {
    const second = vi.fn();
    hooks.registerAuditHook({
      name: 'broken',
      onEvent: () => {
        throw new Error('exporter exploded');
      },
    });
    hooks.registerAuditHook({ name: 'healthy', onEvent: second });

    expect(() => emit.emitAuditEvent(EVENT_INPUT)).not.toThrow();

    expect(state.appended).toHaveLength(1); // the log has the event regardless
    expect(second).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Audit hook threw'),
      expect.objectContaining({ hook: 'broken', action: 'groups.list' }),
    );
  });
});

describe('lifecycle', () => {
  it('initAuditHooks surfaces a failing init as a fatal error naming the hook', () => {
    hooks.registerAuditHook({ name: 'ok', onEvent: () => {}, init: vi.fn() });
    hooks.registerAuditHook({
      name: 'bad-boot',
      onEvent: () => {},
      init: () => {
        throw new Error('no route to collector');
      },
    });

    expect(() => hooks.initAuditHooks()).toThrow(/audit hook "bad-boot" failed to initialize.*no route/);
  });

  it('defers init() until boot for a hook registered before initAuditHooks', () => {
    const init = vi.fn();
    hooks.registerAuditHook({ name: 'early', onEvent: () => {}, init });

    expect(init).not.toHaveBeenCalled(); // not yet — boot hasn't run
    hooks.initAuditHooks();
    expect(init).toHaveBeenCalledTimes(1); // exactly once, at boot
  });

  it('runs init() immediately for a hook registered after boot — import-order-insensitive', () => {
    hooks.initAuditHooks(); // boot completes (no hooks yet)
    const init = vi.fn();
    const onEvent = vi.fn();

    hooks.registerAuditHook({ name: 'late', onEvent, init });

    // A module that loaded after the CLI adapter still gets its one-time init...
    expect(init).toHaveBeenCalledTimes(1);
    // ...and still receives events (onEvent already read the live array).
    emit.emitAuditEvent(EVENT_INPUT);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('a hook registered after boot whose init throws is fatal, naming the hook', () => {
    hooks.initAuditHooks();

    expect(() =>
      hooks.registerAuditHook({
        name: 'late-bad',
        onEvent: () => {},
        init: () => {
          throw new Error('no route to collector');
        },
      }),
    ).toThrow(/audit hook "late-bad" failed to initialize.*no route/);
  });

  it('maintainAuditHooks calls every maintain and isolates throws', () => {
    const m1 = vi.fn(() => {
      throw new Error('flush failed');
    });
    const m2 = vi.fn();
    hooks.registerAuditHook({ name: 'a', onEvent: () => {}, maintain: m1 });
    hooks.registerAuditHook({ name: 'b', onEvent: () => {}, maintain: m2 });
    hooks.registerAuditHook({ name: 'c', onEvent: () => {} }); // no maintain — fine

    expect(() => hooks.maintainAuditHooks()).not.toThrow();
    expect(m1).toHaveBeenCalledTimes(1);
    expect(m2).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('maintenance failed'),
      expect.objectContaining({ hook: 'a' }),
    );
  });

  it('shutdownAuditHooks awaits async shutdowns and isolates throws', async () => {
    const order: string[] = [];
    hooks.registerAuditHook({
      name: 'a',
      onEvent: () => {},
      shutdown: async () => {
        await Promise.resolve();
        order.push('a');
      },
    });
    hooks.registerAuditHook({
      name: 'b',
      onEvent: () => {},
      shutdown: () => {
        throw new Error('handle already closed');
      },
    });
    hooks.registerAuditHook({
      name: 'c',
      onEvent: () => {},
      shutdown: () => {
        order.push('c');
      },
    });

    await hooks.shutdownAuditHooks();

    expect(order).toEqual(['a', 'c']);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('shutdown failed'),
      expect.objectContaining({ hook: 'b' }),
    );
  });

  it('maintainAudit skips hook maintenance when audit is disabled', async () => {
    const init = await import('./init.js');
    const maintain = vi.fn();
    hooks.registerAuditHook({ name: 'a', onEvent: () => {}, maintain });

    state.enabled = false;
    init.maintainAudit();
    expect(maintain).not.toHaveBeenCalled();

    state.enabled = true;
    init.maintainAudit();
    expect(maintain).toHaveBeenCalledTimes(1);
  });
});
