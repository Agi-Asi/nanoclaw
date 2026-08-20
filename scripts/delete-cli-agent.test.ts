import { describe, expect, it, vi } from 'vitest';

import type { SessionDriver, SessionHandle } from '../src/drivers/types.js';

import { stopAgentGroupSessions } from './delete-cli-agent-runtime.js';

function session(agentGroupId: string, sessionId: string): SessionHandle {
  return {
    key: { installSlug: 'test-install', agentGroupId, sessionId },
    name: sessionId,
    start: vi.fn(),
    status: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe('stopAgentGroupSessions', () => {
  it('stops every discovered session for the scratch agent group only', async () => {
    const first = session('scratch-group', 'session-1');
    const second = session('scratch-group', 'session-2');
    const unrelated = session('real-group', 'session-3');
    const driver: Pick<SessionDriver, 'listSessions'> = {
      listSessions: vi.fn().mockResolvedValue([
        { handle: first, phase: 'running' },
        { handle: unrelated, phase: 'running' },
        { handle: second, phase: 'terminal' },
      ]),
    };

    await expect(stopAgentGroupSessions('scratch-group', driver, 'test-install')).resolves.toBe(2);

    expect(driver.listSessions).toHaveBeenCalledWith('test-install');
    expect(first.stop).toHaveBeenCalledWith('setup-test-agent-cleanup');
    expect(second.stop).toHaveBeenCalledWith('setup-test-agent-cleanup');
    expect(unrelated.stop).not.toHaveBeenCalled();
  });
});
