import type { Migration } from './index.js';

/** Scope cached user DMs to the adapter instance that owns the conversation. */
export const migration024: Migration = {
  version: 24,
  name: 'user-dms-instance',
  async up(db) {
    await db.exec(`
      CREATE TABLE user_dms_new (
        user_id            TEXT NOT NULL REFERENCES users(id),
        channel_type       TEXT NOT NULL,
        instance           TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        resolved_at        TEXT NOT NULL,
        PRIMARY KEY (user_id, channel_type, instance)
      )
    `);
    await db.exec(`
      INSERT INTO user_dms_new (user_id, channel_type, instance, messaging_group_id, resolved_at)
        SELECT ud.user_id, ud.channel_type, mg.instance, ud.messaging_group_id, ud.resolved_at
          FROM user_dms ud
          JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
    `);
    await db.exec('DROP TABLE user_dms');
    await db.exec('ALTER TABLE user_dms_new RENAME TO user_dms');
  },
};
