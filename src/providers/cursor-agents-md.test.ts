import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-cursor-agents-md-test/data',
}));

import { composeGroupAgentsMd } from './cursor-agents-md.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import {
  ensureContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../db/container-configs.js';
import { PERSONA_PREPEND_FILE } from '../group-persona.js';
import type { AgentGroup } from '../types.js';

const TEST_ROOT = '/tmp/nanoclaw-cursor-agents-md-test';

function group(folder: string): AgentGroup {
  return {
    id: `ag-${folder}`,
    name: folder,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as AgentGroup;
}

describe('composeGroupAgentsMd', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  });

  it('writes memory and skill pointers without inlining host memory', async () => {
    const g = group('small');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agents-md-'));
    try {
      const sentinel = path.join(TEST_ROOT, 'host-secret');
      fs.writeFileSync(sentinel, 'must not enter AGENTS.md\n');
      fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
      fs.symlinkSync(sentinel, path.join(groupDir, 'memory', 'index.md'));

      await composeGroupAgentsMd(g, groupDir);
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).toContain('supplied by NanoClaw at session startup');
      expect(doc).toContain('~/.cursor/skills');
      expect(doc).toContain('linked memory files');
      expect(doc).not.toContain('must not enter AGENTS.md');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  it('inlines the persona as the first section, before the runtime contract', async () => {
    const g = group('persona');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agents-md-'));
    try {
      fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'You are an SDR agent.\n');
      await composeGroupAgentsMd(g, groupDir);
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).toContain('You are an SDR agent.');
      const firstHeading = doc.split('\n').find((line) => line.startsWith('# '));
      expect(firstHeading).toBe('# Persona');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  it('omits the persona section when no prepend file is present', async () => {
    const g = group('no-persona');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agents-md-'));
    try {
      await composeGroupAgentsMd(g, groupDir);
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).not.toContain('# Persona');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  it('includes MCP instructions without leaking MCP environment values', async () => {
    const g = group('mcp');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    await updateContainerConfigJson(g.id, 'mcp_servers', {
      builds: {
        command: 'bun',
        args: ['builds.ts'],
        env: { PRIVATE_TOKEN: 'must-not-enter-agents-md' },
        instructions: 'Use this server for build status.',
      },
      noInstructions: {
        command: 'bun',
        args: ['quiet.ts'],
        env: {},
      },
    });
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agents-md-'));
    try {
      await composeGroupAgentsMd(g, groupDir);
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).toContain('# NanoClaw Runtime Contract');
      expect(doc).toContain('# MCP Server: builds');
      expect(doc).toContain('Use this server for build status.');
      expect(doc).not.toContain('must-not-enter-agents-md');
      expect(doc).not.toContain('# MCP Server: noInstructions');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  it('omits CLI instructions when the group CLI scope is disabled', async () => {
    const g = group('no-cli');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    await updateContainerConfigScalars(g.id, { cli_scope: 'disabled' });
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agents-md-'));
    try {
      await composeGroupAgentsMd(g, groupDir);
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).not.toContain('# NanoClaw Module: cli');
      expect(doc).not.toContain('# NanoClaw Module: scheduling');
      expect(doc).toContain('# Memory System');
      expect(doc).toContain('# Native Runtime Skills');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  it('ignores null and non-object MCP entries instead of blocking AGENTS.md composition', async () => {
    const g = group('null-mcp');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    await getDb().run(
      'UPDATE container_configs SET mcp_servers = ? WHERE agent_group_id = ?',
      JSON.stringify({
        broken: null,
        alsoBroken: 'not-an-object',
        ok: { command: 'x', instructions: 'use the ok server' },
      }),
      g.id,
    );
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agents-md-'));
    try {
      await expect(composeGroupAgentsMd(g, groupDir)).resolves.toBeUndefined();
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).toContain('# MCP Server: ok');
      expect(doc).toContain('use the ok server');
      expect(doc).not.toContain('# MCP Server: broken');
      expect(doc).not.toContain('# MCP Server: alsoBroken');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  it('ignores malformed MCP config instead of blocking AGENTS.md composition', async () => {
    const g = group('malformed-mcp');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    await getDb().run('UPDATE container_configs SET mcp_servers = ? WHERE agent_group_id = ?', '{broken', g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agents-md-'));
    try {
      await expect(composeGroupAgentsMd(g, groupDir)).resolves.toBeUndefined();
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).toContain('# NanoClaw Runtime Contract');
      expect(doc).not.toContain('# MCP Server:');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  it('replaces stale AGENTS.md content on every compose', async () => {
    const g = group('stale');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agents-md-'));
    try {
      fs.writeFileSync(path.join(groupDir, 'AGENTS.md'), 'stale instructions that must disappear\n');
      await composeGroupAgentsMd(g, groupDir);
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).not.toContain('stale instructions that must disappear');
      expect(doc).toContain('# NanoClaw Runtime Contract');
      expect(fs.readdirSync(groupDir).some((entry) => entry.startsWith('AGENTS.md.tmp-'))).toBe(false);
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  it('does not follow a pre-created temporary-file symlink', async () => {
    const g = group('temp-symlink');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agents-md-'));
    const target = path.join(TEST_ROOT, 'host-target');
    fs.writeFileSync(target, 'unchanged\n');
    fs.symlinkSync(target, path.join(groupDir, `AGENTS.md.tmp-${process.pid}`));
    try {
      await composeGroupAgentsMd(g, groupDir);
      expect(fs.readFileSync(target, 'utf-8')).toBe('unchanged\n');
      expect(fs.lstatSync(path.join(groupDir, 'AGENTS.md')).isSymbolicLink()).toBe(false);
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });
});
