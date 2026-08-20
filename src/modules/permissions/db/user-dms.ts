import type { UserDm } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

type UserDmInput = Omit<UserDm, 'instance'> & { instance?: string };

export async function upsertUserDm(row: UserDmInput): Promise<void> {
  await getDb().run(
    `INSERT INTO user_dms (user_id, channel_type, instance, messaging_group_id, resolved_at)
       VALUES (@user_id, @channel_type, @instance, @messaging_group_id, @resolved_at)
       ON CONFLICT(user_id, channel_type, instance) DO UPDATE SET
         messaging_group_id = excluded.messaging_group_id,
         resolved_at = excluded.resolved_at`,
    { ...row, instance: row.instance ?? row.channel_type },
  );
}

export async function getUserDm(userId: string, channelType: string, instance?: string): Promise<UserDm | undefined> {
  if (instance !== undefined) {
    return getDb().get<UserDm>(
      'SELECT * FROM user_dms WHERE user_id = ? AND channel_type = ? AND instance = ?',
      userId,
      channelType,
      instance,
    );
  }
  return getDb().get<UserDm>(
    `SELECT * FROM user_dms
      WHERE user_id = ? AND channel_type = ?
      ORDER BY (instance = channel_type) DESC, instance ASC
      LIMIT 1`,
    userId,
    channelType,
  );
}

export async function getUserDmsForUser(userId: string): Promise<UserDm[]> {
  return getDb().all<UserDm>('SELECT * FROM user_dms WHERE user_id = ?', userId);
}

export async function deleteUserDm(userId: string, channelType: string): Promise<void> {
  await getDb().run('DELETE FROM user_dms WHERE user_id = ? AND channel_type = ?', userId, channelType);
}
