/**
 * AGENTS.md composition for Cursor agent groups — Cursor-owned payload code.
 *
 * AGENTS.md is Cursor's project doc (its CLAUDE.md equivalent). Composed fresh
 * on every spawn by the cursor provider contribution (see ./cursor.ts) from:
 *   - the shared base (`container/AGENTS.md`)
 *   - a pointer to the runner-scaffolded memory system (content is supplied by
 *     the provider's native sessionStart hook — nothing is read here)
 *   - a pointer to Cursor-native skills under `.cursor/skills`
 *   - each enabled NanoClaw module's `*.instructions.md` fragment
 *   - MCP server `instructions` from container.json
 *
 * Cursor does not publish a hard project-doc byte cap the way Codex does.
 * Compose still warns when the doc is huge so a runaway MCP instructions
 * blob is visible in host logs, but it never throws — a per-spawn throw
 * rides wakeContainer's transient-retry contract and the group goes dark.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { McpServerConfig } from '../container-config.js';
import { getContainerConfig } from '../db/container-configs.js';
import { readGroupPersona } from '../group-persona.js';
import { log } from '../log.js';
import type { AgentGroup } from '../types.js';

export const CURSOR_PROJECT_DOC_WARN_BYTES = 32 * 1024;

const HEADER = '<!-- Composed at spawn. Do not edit. Edit memory/system/definition.md for memory behavior. -->';
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

const MEMORY_POINTER = [
  'The live memory index and definition are supplied by NanoClaw at session startup, clear, and after compaction.',
  'Editable memory-system definition: `/workspace/agent/memory/system/definition.md`.',
  'Top memory index: `/workspace/agent/memory/index.md`.',
  'Read the definition and index, then use linked memory files and conversation archives when relevant.',
  'Stored user preferences are binding: read any linked memory file relevant to the user or the request, and apply it without being asked.',
  'Do not use `AGENTS.local.md` or `AGENTS.override.md` for memory.',
].join('\n\n');

const NATIVE_RUNTIME_SKILLS_POINTER = [
  'Selected NanoClaw runtime skills are available as Cursor-native skills at `/workspace/agent/.cursor/skills` and `~/.cursor/skills`.',
  'Each skill directory contains a `SKILL.md` with its trigger description plus any supporting files, and points to the read-only shared skill source under `/app/skills`.',
  'Use skill discovery to load these skills only when their descriptions match the task. Full skill instructions live in the skill directories, not in `AGENTS.md`.',
  'Skills YOU author or install yourself go in `~/.cursor/skills/<name>/SKILL.md` — persistent across sessions and discovered by Cursor automatically. Never write skills elsewhere: paths outside `~/.cursor` are ephemeral or not discovered.',
].join('\n\n');

interface AgentsMdSection {
  name: string;
  content: string;
}

export async function composeGroupAgentsMd(group: AgentGroup, groupDir: string): Promise<void> {
  if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });

  const configRow = await getContainerConfig(group.id);
  let mcpServers: Record<string, McpServerConfig> = {};
  if (configRow) {
    try {
      const parsed = JSON.parse(configRow.mcp_servers) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        mcpServers = parsed as Record<string, McpServerConfig>;
      } else {
        log.warn('Ignoring non-object MCP server config while composing Cursor AGENTS.md', { group: group.name });
      }
    } catch (err) {
      log.warn('Ignoring malformed MCP server config while composing Cursor AGENTS.md', {
        group: group.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sections: AgentsMdSection[] = [{ name: 'header', content: HEADER }];
  const pushSection = (name: string, ...content: string[]): void => {
    const body = content
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');
    if (body) sections.push({ name, content: `# ${name}\n\n${body}` });
  };

  const persona = readGroupPersona(groupDir);
  if (persona) pushSection('Persona', persona);

  const sharedBase = path.join(process.cwd(), 'container', 'AGENTS.md');
  if (fs.existsSync(sharedBase)) {
    pushSection('NanoClaw Runtime Contract', fs.readFileSync(sharedBase, 'utf-8'));
  }

  pushSection('Memory System', MEMORY_POINTER);
  pushSection('Native Runtime Skills', NATIVE_RUNTIME_SKILLS_POINTER);

  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir).sort()) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (cliDisabled && (moduleName === 'cli' || moduleName === 'scheduling')) continue;
      pushSection(`NanoClaw Module: ${moduleName}`, fs.readFileSync(path.join(mcpToolsHostDir, entry), 'utf-8'));
    }
  }

  for (const [name, mcp] of Object.entries(mcpServers)) {
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) {
      log.warn('Ignoring non-object MCP server entry while composing Cursor AGENTS.md', {
        group: group.name,
        server: name,
      });
      continue;
    }
    if (typeof mcp.instructions === 'string' && mcp.instructions.trim()) {
      pushSection(`MCP Server: ${name}`, mcp.instructions);
    }
  }

  const content = renderAgentsMd(sections);
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes >= CURSOR_PROJECT_DOC_WARN_BYTES) {
    log.warn('AGENTS.md is large for a Cursor project doc', {
      group: group.name,
      bytes,
      warnBytes: CURSOR_PROJECT_DOC_WARN_BYTES,
    });
  }
  writeAtomic(path.join(groupDir, 'AGENTS.md'), content);
}

function renderAgentsMd(sections: AgentsMdSection[]): string {
  return (
    sections
      .map((section) => section.content.trim())
      .filter(Boolean)
      .join('\n\n') + '\n'
  );
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* renamed or never created */
    }
  }
}
