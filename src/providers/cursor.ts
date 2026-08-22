/**
 * Host-side container config for the `cursor` provider.
 *
 * Registers with `providesAgentSurfaces` — Cursor owns its agent-facing
 * surfaces, so core skips the default (Claude) compose/mounts and this
 * contribution supplies them instead:
 *
 *   - AGENTS.md — Cursor's project doc, composed fresh every spawn
 *     (see ./cursor-agents-md.ts), mounted RO over the RW group dir.
 *   - .cursor/skills — Cursor-native skill links synced to the group's
 *     container.json selection. Also mirrored at `$HOME/.cursor/skills`
 *     because the agent workspace is not a git repo (same reason Codex
 *     mounts `$HOME/.agents/skills`).
 *   - ~/.cursor — a per-GROUP private state dir (`.cursor-shared`),
 *     persistent across sessions so the local agent SQLite/JSONL store
 *     survives respawns.
 *
 * The long-lived credential stays in OneCLI. The container receives
 * `CURSOR_API_KEY=placeholder` so `@cursor/sdk` emits an Authorization header
 * that OneCLI rewrites for key exchange and model discovery. The SDK holds the
 * exchanged short-lived access token in process and sends it through the same
 * configured proxy. Whether the vaulted value came from Cursor-account OAuth
 * or a pasted dashboard key is invisible inside the container.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { materializeTemplateSkills } from '../group-skills.js';
import { log } from '../log.js';
import { composeGroupAgentsMd } from './cursor-agents-md.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/** Sentinel so the SDK always sends Authorization for OneCLI to overwrite. */
export const CURSOR_API_KEY_PLACEHOLDER = 'cursor_placeholder_nanoclaw';

registerProviderContainerConfig(
  'cursor',
  async (ctx) => {
    const cursorDir = path.join(DATA_DIR, 'v2-sessions', ctx.agentGroupId, '.cursor-shared');
    fs.mkdirSync(cursorDir, { recursive: true });

    const group = await getAgentGroup(ctx.agentGroupId);
    if (group) await composeGroupAgentsMd(group, ctx.groupDir);

    const projectSkillsDir = path.join(ctx.groupDir, '.cursor', 'skills');
    const homeSkillsDir = path.join(cursorDir, 'skills');
    if (syncCursorSkillLinks(projectSkillsDir, ctx.selectedSkills)) {
      materializeTemplateSkills(ctx.agentGroupId, projectSkillsDir);
    }
    if (syncCursorSkillLinks(homeSkillsDir, ctx.selectedSkills)) {
      materializeTemplateSkills(ctx.agentGroupId, homeSkillsDir);
    }

    const mounts = [{ hostPath: cursorDir, containerPath: '/home/node/.cursor', readonly: false }];
    const composedAgentsMd = path.join(ctx.groupDir, 'AGENTS.md');
    if (fs.existsSync(composedAgentsMd)) {
      mounts.push({
        hostPath: composedAgentsMd,
        containerPath: '/workspace/agent/AGENTS.md',
        readonly: true,
      });
    }

    return {
      mounts,
      env: { CURSOR_API_KEY: CURSOR_API_KEY_PLACEHOLDER },
    };
  },
  { providesAgentSurfaces: true },
);

/**
 * Sync `<dest>/ <name>` symlinks to the selected skill set. Targets are
 * container paths (`/app/skills/<name>`) — dangling on the host, valid inside.
 */
function ensureRealDirectory(dir: string): boolean {
  try {
    const entry = fs.lstatSync(dir);
    if (entry.isDirectory() && !entry.isSymbolicLink()) return true;
    log.warn('Refusing to reconcile Cursor skills through a non-directory path', { path: dir });
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Unable to inspect Cursor skills directory', {
        path: dir,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
  fs.mkdirSync(dir);
  return true;
}

function validSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);
}

function skillLinkPath(skillsDir: string, name: string): string | null {
  if (!validSkillName(name)) return null;
  const linkPath = path.resolve(skillsDir, name);
  if (path.dirname(linkPath) !== path.resolve(skillsDir)) return null;
  return linkPath;
}

function syncCursorSkillLinks(skillsDir: string, selectedSkills: string[]): boolean {
  if (!ensureRealDirectory(path.dirname(skillsDir)) || !ensureRealDirectory(skillsDir)) return false;

  const desired = new Set<string>();
  for (const skill of selectedSkills) {
    if (skillLinkPath(skillsDir, skill)) desired.add(skill);
    else log.warn('Ignoring invalid Cursor skill name', { skill });
  }
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desired.has(entry)) fs.unlinkSync(entryPath);
  }

  for (const skill of desired) {
    const linkPath = skillLinkPath(skillsDir, skill);
    if (!linkPath) continue;
    const target = `/app/skills/${skill}`;
    try {
      const entry = fs.lstatSync(linkPath);
      if (!entry.isSymbolicLink() || fs.readlinkSync(linkPath) === target) continue;
      fs.unlinkSync(linkPath);
    } catch {
      /* create missing link below */
    }
    fs.symlinkSync(target, linkPath);
  }
  return true;
}
