import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initSqliteTestDb } from './connection.js';
import { sqliteRaw } from './drivers/sqlite.js';
import { migrations, runMigrations } from './migrations/index.js';

function now(): string {
  return new Date().toISOString();
}

afterEach(async () => {
  await closeDb();
});

describe('migration 024 — user DM instances', () => {
  it('backfills the owning instance and allows sibling DMs for one user', async () => {
    const db = await initSqliteTestDb();
    await runMigrations(
      db,
      migrations.filter((migration) => migration.name !== 'user-dms-instance'),
    );
    const raw = sqliteRaw(getDb());

    raw.prepare("INSERT INTO users (id, kind, created_at) VALUES ('slack:U1', 'slack', ?)").run(now());
    raw
      .prepare(
        `INSERT INTO messaging_groups
          (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, 'slack', ?, ?, NULL, 0, 'strict', ?)`,
      )
      .run('mg-a', 'D-A', 'slack-a', now());
    raw
      .prepare(
        `INSERT INTO messaging_groups
          (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, 'slack', ?, ?, NULL, 0, 'strict', ?)`,
      )
      .run('mg-b', 'D-B', 'slack-b', now());
    raw
      .prepare(
        `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
         VALUES ('slack:U1', 'slack', 'mg-a', ?)`,
      )
      .run(now());

    await runMigrations(db);

    expect(raw.prepare("SELECT instance FROM user_dms WHERE messaging_group_id = 'mg-a'").get()).toEqual({
      instance: 'slack-a',
    });
    raw
      .prepare(
        `INSERT INTO user_dms (user_id, channel_type, instance, messaging_group_id, resolved_at)
         VALUES ('slack:U1', 'slack', 'slack-b', 'mg-b', ?)`,
      )
      .run(now());
    expect(raw.prepare("SELECT COUNT(*) AS count FROM user_dms WHERE user_id = 'slack:U1'").get()).toEqual({
      count: 2,
    });
  });
});
