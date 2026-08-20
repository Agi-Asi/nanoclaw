import { INSTALL_SLUG } from '../src/config.js';
import { getSessionDriver } from '../src/drivers/index.js';
import type { SessionDriver } from '../src/drivers/types.js';

export async function stopAgentGroupSessions(
  agentGroupId: string,
  driver: Pick<SessionDriver, 'listSessions'> = getSessionDriver(),
  installSlug = INSTALL_SLUG,
): Promise<number> {
  const sessions = (await driver.listSessions(installSlug)).filter(
    ({ handle }) => handle.key.agentGroupId === agentGroupId,
  );
  await Promise.all(sessions.map(({ handle }) => handle.stop('setup-test-agent-cleanup')));
  return sessions.length;
}
