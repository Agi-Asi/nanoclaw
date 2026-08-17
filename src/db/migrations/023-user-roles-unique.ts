import type { Migration } from './index.js';

/**
 * SQLite treats NULL values as distinct inside a composite primary key, so
 * the original (user_id, role, agent_group_id) key allowed duplicate global
 * owner/admin grants. Collapse any existing duplicates, then enforce the two
 * logical key shapes explicitly. A remote baseline must preserve these
 * indexes instead of relying on nullable-key behavior.
 */
export const migration023: Migration = {
  version: 23,
  name: 'user-roles-unique',
  sqliteOnly: true,
  up(db) {
    db.exec(`
      DELETE FROM user_roles
      WHERE rowid NOT IN (
        SELECT MIN(rowid)
        FROM user_roles
        GROUP BY user_id, role, agent_group_id
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_global_unique
        ON user_roles(user_id, role)
        WHERE agent_group_id IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_scoped_unique
        ON user_roles(user_id, role, agent_group_id)
        WHERE agent_group_id IS NOT NULL;
    `);
  },
};
