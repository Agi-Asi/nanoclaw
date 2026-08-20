/** Apply every code-carrying channel skill to a disposable CI checkout, then run one shared gate. */
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { applySkill } from './skill-apply.js';

const CHANNEL_SKILLS = [
  'add-deltachat',
  'add-discord',
  'add-emacs',
  'add-gchat',
  'add-github',
  'add-imessage',
  'add-linear',
  'add-matrix',
  'add-mattermost',
  'add-resend',
  'add-signal',
  'add-slack',
  'add-teams',
  'add-telegram',
  'add-webex',
  'add-wechat',
  'add-whatsapp',
  'add-whatsapp-cloud',
  'slack-a2a-rooms',
  'slack-agent-flow',
] as const;

if (process.env.CI !== 'true') {
  throw new Error('This mutates its checkout and only runs in disposable CI.');
}

const root = process.cwd();
const stagedSkills = mkdtempSync(join(tmpdir(), 'nanoclaw-channel-skills-'));
const skipEffects = ['build', 'test', 'check', 'external', 'fetch', 'restart', 'step', 'wire'];
const channelsRemote = process.env.CHANNELS_REMOTE ?? 'origin';
const channelsRef = process.env.CHANNELS_REF || `${channelsRemote}/channels`;

function run(command: string): string {
  if (command === `git fetch ${channelsRemote} channels`) return '';
  return execSync(command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

if (!process.env.CHANNELS_REF) {
  execFileSync('git', ['fetch', channelsRemote, 'channels'], { cwd: root, stdio: 'inherit' });
}

try {
  for (const name of CHANNEL_SKILLS) {
    const skillDir = join(stagedSkills, name);
    const prefix = `.claude/skills/${name}/`;
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', channelsRef, '--', prefix], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    for (const file of files) {
      const target = join(skillDir, file.slice(prefix.length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, execFileSync('git', ['show', `${channelsRef}:${file}`], { cwd: root }));
    }

    const result = await applySkill(skillDir, root, {
      mode: 'install',
      skipEffects: name === 'add-matrix' ? skipEffects.filter((effect) => effect !== 'external') : skipEffects,
      exec: run,
      resolveRemote: () => channelsRemote,
    });
    if (result.agentTasks.length > 0) {
      throw new Error(`${name} did not apply: ${result.agentTasks.map((task) => task.reason).join('; ')}`);
    }
  }
} finally {
  rmSync(stagedSkills, { recursive: true, force: true });
}

for (const command of [
  'pnpm run format:check',
  'pnpm run build',
  'pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit',
  'pnpm exec vitest run',
  'cd container/agent-runner && bun test',
]) {
  execSync(command, { cwd: root, stdio: 'inherit' });
}
