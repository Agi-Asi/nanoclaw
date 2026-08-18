import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, initSqliteTestDb } from '../connection.js';
import { sqliteRaw } from '../drivers/sqlite.js';
import { lookup } from '../../cli/registry.js';
import { migration023 } from './023-user-roles-unique.js';
import { migrations, runMigrations } from './index.js';
import '../../cli/resources/roles.js';

afterEach(async () => await closeDb());

describe('user-roles-unique migration', () => {
  it('deduplicates nullable global grants and enforces both logical key shapes', async () => {
    const db = await initSqliteTestDb();
    await runMigrations(
      db,
      migrations.filter((migration) => migration.name !== migration023.name),
    );

    const now = new Date().toISOString();
    sqliteRaw(db).prepare('INSERT INTO users (id, kind, created_at) VALUES (?, ?, ?)').run('cli:owner', 'cli', now);
    sqliteRaw(db)
      .prepare('INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)')
      .run('ag-1', 'Agent', 'agent', now);
    const insert = sqliteRaw(db).prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, ?, ?, NULL, ?)`,
    );
    insert.run('cli:owner', 'owner', null, now);
    insert.run('cli:owner', 'owner', null, now);
    insert.run('cli:owner', 'admin', 'ag-1', now);

    await runMigrations(db, [migration023]);

    const global = sqliteRaw(db)
      .prepare("SELECT COUNT(*) AS count FROM user_roles WHERE role = 'owner' AND agent_group_id IS NULL")
      .get() as { count: number };
    expect(global.count).toBe(1);
    expect(() => insert.run('cli:owner', 'owner', null, now)).toThrow();
    expect(() => insert.run('cli:owner', 'admin', 'ag-1', now)).toThrow();
  });

  it('makes repeated global grants through ncl idempotent', async () => {
    const db = await initSqliteTestDb();
    await runMigrations(db);
    sqliteRaw(db)
      .prepare('INSERT INTO users (id, kind, created_at) VALUES (?, ?, ?)')
      .run('cli:owner', 'cli', new Date().toISOString());

    const grant = lookup('roles-grant');
    expect(grant).toBeDefined();
    await grant!.handler({ user: 'cli:owner', role: 'owner' }, { caller: 'host' });
    await grant!.handler({ user: 'cli:owner', role: 'owner' }, { caller: 'host' });

    const row = sqliteRaw(db).prepare("SELECT COUNT(*) AS count FROM user_roles WHERE role = 'owner'").get() as {
      count: number;
    };
    expect(row.count).toBe(1);
  });
});
