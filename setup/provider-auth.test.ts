import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyProviderSkill: vi.fn(),
  buildContainerImage: vi.fn(),
  getSetupProvider: vi.fn(),
  listSetupProviders: vi.fn(),
  registerSetupProvider: vi.fn(),
  runAuth: vi.fn(),
  runInstallCheck: vi.fn(),
}));

vi.mock('./providers/install.js', () => ({
  applyProviderSkill: mocks.applyProviderSkill,
}));

vi.mock('./lib/container-build.js', () => ({
  buildContainerImage: mocks.buildContainerImage,
}));

vi.mock('./providers/registry.js', () => ({
  getSetupProvider: mocks.getSetupProvider,
  listSetupProviders: mocks.listSetupProviders,
  registerSetupProvider: mocks.registerSetupProvider,
}));

import { run } from './provider-auth.js';

const cursorEntry = {
  value: 'cursor',
  label: 'Cursor',
  hint: 'Cursor',
  runAuth: mocks.runAuth,
  runInstallCheck: mocks.runInstallCheck,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.applyProviderSkill.mockResolvedValue({
    apply: {
      applied: [],
      skipped: [],
      deferred: [],
      agentTasks: [],
      operatorMessages: [],
      vars: {},
      journal: [],
      referenceProse: '',
    },
    changed: false,
    blockers: [],
  });
  mocks.buildContainerImage.mockReturnValue({ ok: true });
  mocks.getSetupProvider.mockImplementation((name: string) => (name === 'cursor' ? cursorEntry : undefined));
  mocks.listSetupProviders.mockReturnValue([cursorEntry]);
  vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  }) as typeof process.exit);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('standalone provider auth setup', () => {
  it('prints usage and exits before mutation when the provider is missing', async () => {
    await expect(run([])).rejects.toThrow('exit:1');
    expect(mocks.applyProviderSkill).not.toHaveBeenCalled();
    expect(mocks.runAuth).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider without attempting an install', async () => {
    mocks.getSetupProvider.mockReturnValue(undefined);
    mocks.listSetupProviders.mockReturnValue([cursorEntry]);
    await expect(run(['unknown'])).rejects.toThrow('exit:1');
    expect(mocks.applyProviderSkill).not.toHaveBeenCalled();
  });

  it('rejects a provider that uses the standard auth flow', async () => {
    mocks.getSetupProvider.mockReturnValue({
      value: 'claude',
      label: 'Claude',
      hint: 'default',
    });
    await expect(run(['claude'])).rejects.toThrow('exit:1');
    expect(mocks.applyProviderSkill).not.toHaveBeenCalled();
  });

  it('refreshes Cursor, skips rebuild when nothing changed, then runs auth and verification', async () => {
    await run(['  CuRsOr  ']);
    expect(mocks.applyProviderSkill).toHaveBeenCalledWith('.claude/skills/add-cursor', process.cwd());
    expect(mocks.buildContainerImage).not.toHaveBeenCalled();
    expect(mocks.runAuth).toHaveBeenCalledOnce();
    expect(mocks.runInstallCheck).toHaveBeenCalledOnce();
    expect(mocks.runAuth).toHaveBeenCalledWith({ force: false });
    expect(mocks.runAuth.mock.invocationCallOrder[0]).toBeLessThan(mocks.runInstallCheck.mock.invocationCallOrder[0]!);
  });

  it('forwards --force so an expired existing credential can be rotated', async () => {
    await run(['cursor', '--force']);
    expect(mocks.runAuth).toHaveBeenCalledWith({ force: true });
    expect(mocks.runInstallCheck).toHaveBeenCalledOnce();
  });

  it('rebuilds before auth when provider installation changes files', async () => {
    mocks.applyProviderSkill.mockResolvedValueOnce({
      apply: {
        applied: ['copy: cursor.ts'],
        skipped: [],
        deferred: [],
        agentTasks: [],
        operatorMessages: [],
        vars: {},
        journal: [],
        referenceProse: '',
      },
      changed: true,
      blockers: [],
    });
    await run(['cursor']);
    expect(mocks.buildContainerImage).toHaveBeenCalledOnce();
    expect(mocks.buildContainerImage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runAuth.mock.invocationCallOrder[0]!,
    );
  });

  it('stops before rebuild and auth when deterministic installation has blockers', async () => {
    mocks.applyProviderSkill.mockResolvedValueOnce({
      apply: {
        applied: [],
        skipped: [],
        deferred: ['missing input'],
        agentTasks: [],
        operatorMessages: [],
        vars: {},
        journal: [],
        referenceProse: '',
      },
      changed: false,
      blockers: ['missing input'],
    });
    await expect(run(['cursor'])).rejects.toThrow('exit:1');
    expect(mocks.buildContainerImage).not.toHaveBeenCalled();
    expect(mocks.runAuth).not.toHaveBeenCalled();
  });

  it('stops before auth when the container rebuild fails', async () => {
    mocks.applyProviderSkill.mockResolvedValueOnce({
      apply: {
        applied: ['copy: cursor.ts'],
        skipped: [],
        deferred: [],
        agentTasks: [],
        operatorMessages: [],
        vars: {},
        journal: [],
        referenceProse: '',
      },
      changed: true,
      blockers: [],
    });
    mocks.buildContainerImage.mockReturnValueOnce({
      ok: false,
      message: 'docker unavailable',
      hint: 'start Docker',
    });
    await expect(run(['cursor'])).rejects.toThrow('exit:1');
    expect(mocks.runAuth).not.toHaveBeenCalled();
    expect(mocks.runInstallCheck).not.toHaveBeenCalled();
  });

  it('loads a newly installed provider before running auth', async () => {
    mocks.getSetupProvider.mockReturnValueOnce(undefined).mockReturnValueOnce(cursorEntry);
    await run(['cursor'], async () => {});
    expect(mocks.runAuth).toHaveBeenCalledOnce();
    expect(mocks.runInstallCheck).toHaveBeenCalledOnce();
  });

  it('fails closed when installation completes but the provider does not register', async () => {
    mocks.getSetupProvider.mockReturnValue(undefined);
    await expect(run(['cursor'], async () => {})).rejects.toThrow('exit:1');
    expect(mocks.runAuth).not.toHaveBeenCalled();
  });

  it('does not run install verification when auth fails', async () => {
    mocks.runAuth.mockRejectedValueOnce(new Error('auth failed'));
    await expect(run(['cursor'])).rejects.toThrow('auth failed');
    expect(mocks.runInstallCheck).not.toHaveBeenCalled();
  });
});
