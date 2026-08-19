/**
 * In-process seam test for the cursor HOST contribution's runtime consumption
 * of core: drive the REAL registered contribution — via the real barrel and
 * registry, never by importing cursor.ts's internals — against a real test DB
 * and a temp GROUPS_DIR/DATA_DIR, then hand its result to the real buildMounts.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-cursor-host-contribution-test';
const DATA_DIR = path.join(TEST_ROOT, 'data');
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-cursor-host-contribution-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-cursor-host-contribution-test/groups',
}));

import { buildMounts } from '../container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import './index.js';
import type { ContainerConfig } from '../container-config.js';
import type { AgentGroup, Session } from '../types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

describe('cursor host contribution against real core', () => {
  beforeEach(async () => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    await closeDb();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('creates the per-group state dir, composes AGENTS.md, and passes a placeholder key', async () => {
    const ag = group('ag-cursor', 'cursor-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    await updateContainerConfigJson(ag.id, 'mcp_servers', {
      tooling: { command: 'x', instructions: 'use the tooling server for builds' },
    });
    const groupDir = path.join(GROUPS_DIR, ag.folder);

    const contributionFn = getProviderContainerConfig('cursor');
    expect(contributionFn).toBeDefined();
    const contribution = await contributionFn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir,
      selectedSkills: ['welcome'],
      hostEnv: process.env,
    });

    const cursorShared = path.join(DATA_DIR, 'v2-sessions', ag.id, '.cursor-shared');
    expect(fs.existsSync(cursorShared)).toBe(true);
    const cursorMount = contribution.mounts?.find((m) => m.containerPath === '/home/node/.cursor');
    expect(cursorMount).toMatchObject({ hostPath: cursorShared, readonly: false });
    expect(contribution.env?.CURSOR_API_KEY).toBe('cursor_placeholder_nanoclaw');

    const agentsMd = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('MCP Server: tooling');
    expect(agentsMd).toContain('use the tooling server for builds');

    expect(fs.lstatSync(path.join(groupDir, '.cursor', 'skills', 'welcome')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(cursorShared, 'skills', 'welcome')).isSymbolicLink()).toBe(true);

    const session = { id: 'session-1', agent_group_id: ag.id } as Session;
    const config: ContainerConfig = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    };
    const mounts = await buildMounts(ag, session, config, 'cursor', contribution);
    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).toContain('/home/node/.cursor');
    expect(containerPaths.some((p) => p.endsWith('AGENTS.md'))).toBe(true);
    expect(containerPaths).not.toContain('/home/node/.claude');
  });

  it('mirrors per-group template skills from the Claude plane into .cursor/skills', async () => {
    const ag = group('ag-cursor-skills', 'cursor-skills-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    const templateSkill = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills', 'widget');
    fs.mkdirSync(templateSkill, { recursive: true });
    fs.writeFileSync(path.join(templateSkill, 'SKILL.md'), '---\nname: widget\n---\n');

    const contributionFn = getProviderContainerConfig('cursor');
    await contributionFn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir: path.join(GROUPS_DIR, ag.folder),
      selectedSkills: [],
      hostEnv: process.env,
    });

    const mirrored = path.join(GROUPS_DIR, ag.folder, '.cursor', 'skills', 'widget');
    expect(fs.existsSync(path.join(mirrored, 'SKILL.md'))).toBe(true);
    expect(fs.lstatSync(mirrored).isSymbolicLink()).toBe(false);
  });

  it('repairs stale selected-skill links and prunes deselected links without deleting real skills', async () => {
    const ag = group('ag-cursor-reconcile', 'cursor-reconcile-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    const contributionFn = getProviderContainerConfig('cursor');
    const context = {
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir: path.join(GROUPS_DIR, ag.folder),
      selectedSkills: ['welcome', 'tooling'],
      hostEnv: process.env,
    };
    await contributionFn!(context);

    const projectSkills = path.join(context.groupDir, '.cursor', 'skills');
    const cursorShared = path.join(DATA_DIR, 'v2-sessions', ag.id, '.cursor-shared');
    const homeSkills = path.join(cursorShared, 'skills');
    for (const skillsDir of [projectSkills, homeSkills]) {
      fs.unlinkSync(path.join(skillsDir, 'welcome'));
      fs.symlinkSync('/wrong/target', path.join(skillsDir, 'welcome'));
      fs.rmSync(path.join(skillsDir, 'tooling'));
      fs.mkdirSync(path.join(skillsDir, 'tooling'));
      fs.writeFileSync(path.join(skillsDir, 'tooling', 'SKILL.md'), 'real skill');
    }

    await contributionFn!({ ...context, selectedSkills: ['welcome'] });

    for (const skillsDir of [projectSkills, homeSkills]) {
      expect(fs.readlinkSync(path.join(skillsDir, 'welcome'))).toBe('/app/skills/welcome');
      expect(fs.readFileSync(path.join(skillsDir, 'tooling', 'SKILL.md'), 'utf-8')).toBe('real skill');
    }
  });

  it('ignores path-traversing skill names while still linking valid skills', async () => {
    const ag = group('ag-cursor-invalid-skill', 'cursor-invalid-skill');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const contributionFn = getProviderContainerConfig('cursor');
    await contributionFn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir,
      selectedSkills: ['../escaped', 'welcome'],
      hostEnv: process.env,
    });

    const cursorShared = path.join(DATA_DIR, 'v2-sessions', ag.id, '.cursor-shared');
    // existsSync follows dangling symlinks and returns false — use lstat so a
    // traversal link at `.cursor/escaped` cannot hide behind a missing target.
    expect(() => fs.lstatSync(path.join(groupDir, '.cursor', 'escaped'))).toThrow();
    expect(() => fs.lstatSync(path.join(cursorShared, 'escaped'))).toThrow();
    expect(fs.readlinkSync(path.join(groupDir, '.cursor', 'skills', 'welcome'))).toBe('/app/skills/welcome');
    expect(fs.readlinkSync(path.join(cursorShared, 'skills', 'welcome'))).toBe('/app/skills/welcome');
  });

  it('rejects control characters and path-like skill names instead of linking them', async () => {
    const ag = group('ag-cursor-weird-skill', 'cursor-weird-skill');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const contributionFn = getProviderContainerConfig('cursor');
    await contributionFn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir,
      selectedSkills: ['welcome\n../escaped', 'welcome foo', '.hidden', 'welcome'],
      hostEnv: process.env,
    });

    const projectSkills = path.join(groupDir, '.cursor', 'skills');
    expect(fs.readdirSync(projectSkills)).toEqual(['welcome']);
    expect(fs.readlinkSync(path.join(projectSkills, 'welcome'))).toBe('/app/skills/welcome');
  });

  it('refuses to materialize skills through a replaced .cursor directory symlink', async () => {
    const ag = group('ag-cursor-skill-escape', 'cursor-skill-escape');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const outside = path.join(TEST_ROOT, 'outside-skill-target');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(groupDir, '.cursor'));

    const contributionFn = getProviderContainerConfig('cursor');
    await contributionFn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir,
      selectedSkills: ['welcome'],
      hostEnv: process.env,
    });

    expect(fs.existsSync(path.join(outside, 'skills'))).toBe(false);
  });

  it('lets a group-specific template skill override a shared skill with the same name', async () => {
    const ag = group('ag-cursor-template-override', 'cursor-template-override');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    const templateSkill = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills', 'welcome');
    fs.mkdirSync(templateSkill, { recursive: true });
    fs.writeFileSync(path.join(templateSkill, 'SKILL.md'), 'group-specific welcome');

    const contributionFn = getProviderContainerConfig('cursor');
    await contributionFn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir: path.join(GROUPS_DIR, ag.folder),
      selectedSkills: ['welcome'],
      hostEnv: process.env,
    });

    const projectSkill = path.join(GROUPS_DIR, ag.folder, '.cursor', 'skills', 'welcome');
    const homeSkill = path.join(DATA_DIR, 'v2-sessions', ag.id, '.cursor-shared', 'skills', 'welcome');
    for (const skillDir of [projectSkill, homeSkill]) {
      expect(fs.lstatSync(skillDir).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toBe('group-specific welcome');
    }
  });

  it('isolates persistent Cursor state between agent groups', async () => {
    const first = group('ag-cursor-first', 'cursor-first');
    const second = group('ag-cursor-second', 'cursor-second');
    for (const ag of [first, second]) {
      await createAgentGroup(ag);
      await ensureContainerConfig(ag.id);
    }
    const contributionFn = getProviderContainerConfig('cursor');
    const contributions = [];
    for (const ag of [first, second]) {
      contributions.push(
        await contributionFn!({
          sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
          agentGroupId: ag.id,
          groupDir: path.join(GROUPS_DIR, ag.folder),
          selectedSkills: [],
          hostEnv: process.env,
        }),
      );
    }

    const stateMounts = contributions.map(
      (contribution) => contribution.mounts?.find((mount) => mount.containerPath === '/home/node/.cursor')?.hostPath,
    );
    expect(stateMounts[0]).not.toBe(stateMounts[1]);
    expect(stateMounts).toEqual([
      path.join(DATA_DIR, 'v2-sessions', first.id, '.cursor-shared'),
      path.join(DATA_DIR, 'v2-sessions', second.id, '.cursor-shared'),
    ]);
  });
});
