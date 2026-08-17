import type { Migration } from './index.js';

/**
 * Active session routing is a logical key even when one or both routing
 * columns are NULL. The in-process keyed lock prevents local duplicates; this
 * index is the cross-process belt-and-braces constraint.
 */
export const migration024: Migration = {
  version: 24,
  name: 'session-routing-unique',
  async up(db) {
    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_routing_unique
        ON sessions (
          agent_group_id,
          COALESCE(messaging_group_id, ''),
          COALESCE(thread_id, '')
        )
        WHERE status = 'active';
    `);
  },
};
