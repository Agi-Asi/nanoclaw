import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecSync = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import { agentRunnerDependenciesSatisfied, applyProviderSkill, isFlowOwnedCommand } from './install.js';

const tempDirs: string[] = [];

beforeEach(() => {
  mockExecSync.mockReset();
  mockExecSync.mockReturnValue('');
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(skill: string, dependency = '1.0.28'): { root: string; skillDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-install-root-'));
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-install-skill-'));
  tempDirs.push(root, skillDir);
  fs.mkdirSync(path.join(root, 'container/agent-runner'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'container/agent-runner/package.json'),
    JSON.stringify({ dependencies: dependency ? { '@cursor/sdk': dependency } : {} }),
  );
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"scratch"}\n');
  fs.writeFileSync(path.join(root, '.env'), '');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill);
  return { root, skillDir };
}

const PROVIDER_SKILL = `# provider

## Copy payload
\`\`\`nc:copy
payload.ts -> src/payload.ts
\`\`\`

## Install subtree dependency
\`\`\`nc:run effect:refresh
cd container/agent-runner && bun add @cursor/sdk@1.0.28
\`\`\`

## Build
\`\`\`nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
\`\`\`

## Test
\`\`\`nc:run effect:test
pnpm vitest run provider.test.ts
cd container/agent-runner && bun test provider.test.ts
\`\`\`

## Authenticate
\`\`\`nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth cursor
\`\`\`
`;

describe('provider install command ownership', () => {
  it.each([
    'pnpm run build',
    'pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit',
    './container/build.sh',
    'pnpm vitest run provider.test.ts',
    'cd container/agent-runner && bun test provider.test.ts',
    'pnpm exec tsx setup/index.ts --step provider-auth cursor',
  ])('recognizes flow-owned command: %s', (cmd) => {
    expect(isFlowOwnedCommand(cmd)).toBe(true);
  });

  it('does not suppress the agent-runner dependency install', () => {
    expect(isFlowOwnedCommand('cd container/agent-runner && bun add @cursor/sdk@1.0.28')).toBe(false);
  });
});

describe('agent-runner dependency idempotence', () => {
  it('accepts only exact pins already present in the agent-runner package', () => {
    const { root } = scratch('# empty\n');
    expect(agentRunnerDependenciesSatisfied('cd container/agent-runner && bun add @cursor/sdk@1.0.28', root)).toBe(
      true,
    );
    expect(agentRunnerDependenciesSatisfied('cd container/agent-runner && bun add @cursor/sdk@1.0.29', root)).toBe(
      false,
    );
    expect(agentRunnerDependenciesSatisfied('pnpm add @cursor/sdk@1.0.28', root)).toBe(false);
  });

  it('fails closed for malformed package metadata', () => {
    const { root } = scratch('# empty\n');
    fs.writeFileSync(path.join(root, 'container/agent-runner/package.json'), '{');
    expect(agentRunnerDependenciesSatisfied('cd container/agent-runner && bun add @cursor/sdk@1.0.28', root)).toBe(
      false,
    );
  });
});

describe('applyProviderSkill lifecycle', () => {
  it('applies payload and skips caller-owned runs', async () => {
    const { root, skillDir } = scratch(PROVIDER_SKILL);
    fs.writeFileSync(path.join(skillDir, 'payload.ts'), 'export const payload = true;\n');

    const first = await applyProviderSkill(skillDir, root);
    expect(first.changed).toBe(true);
    expect(first.blockers).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'src/payload.ts'), 'utf-8')).toContain('payload');
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(first.apply.skipped.filter((entry) => entry === 'run: not part of code refresh')).toHaveLength(3);
  });

  it('runs a missing subtree dependency and marks the install changed', async () => {
    const { root, skillDir } = scratch(PROVIDER_SKILL, '');
    fs.writeFileSync(path.join(skillDir, 'payload.ts'), 'export const payload = true;\n');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/payload.ts'), 'already present\n');

    const result = await applyProviderSkill(skillDir, root);
    expect(result.changed).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith('cd container/agent-runner && bun add @cursor/sdk@1.0.28', {
      cwd: root,
      stdio: 'pipe',
    });
  });

  it('refreshes stale provider-branch payloads but reports identical content as unchanged', async () => {
    const skill = `# branch provider

\`\`\`nc:copy from-branch:providers
payload.ts -> src/payload.ts
\`\`\`
`;
    const { root, skillDir } = scratch(skill);
    let remoteContent = 'export const version = 1;\n';
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('resolve_channels_remote')) return 'origin';
      if (cmd.startsWith('git show ')) {
        const target = cmd.slice(cmd.lastIndexOf('>') + 1).trim();
        fs.writeFileSync(path.join(root, target), remoteContent);
      }
      return '';
    });

    const fresh = await applyProviderSkill(skillDir, root);
    expect(fresh.changed).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src/payload.ts'), 'utf-8')).toBe(remoteContent);

    const identicalRefresh = await applyProviderSkill(skillDir, root);
    expect(identicalRefresh.changed).toBe(false);

    remoteContent = 'export const version = 2;\n';
    const staleRefresh = await applyProviderSkill(skillDir, root);
    expect(staleRefresh.changed).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src/payload.ts'), 'utf-8')).toBe(remoteContent);
    expect(mockExecSync.mock.calls.filter(([cmd]) => String(cmd).startsWith('git show '))).toHaveLength(3);
  });

  it('leaves refresh prompts untouched and surfaces unknown directives as blockers', async () => {
    const skill = `# broken provider

\`\`\`nc:prompt token secret
Token?
\`\`\`

\`\`\`nc:unknown
manual mutation
\`\`\`
`;
    const { root, skillDir } = scratch(skill);
    const result = await applyProviderSkill(skillDir, root);
    expect(result.changed).toBe(false);
    expect(result.apply.skipped).toContain('prompt: not part of code refresh');
    expect(result.blockers.some((blocker) => blocker.includes('no deterministic handler'))).toBe(true);
  });
});
