/**
 * Upgrade-path test for migration 020 (holds-approver-rule): in-flight
 * pending_approvals rows created by the pre-contract code must come out with
 * the approver rule the old click-auth gave them, and the sender table must be
 * gone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './index.js';
import { migrations } from './migrations/index.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = initTestDb();
  // Everything up to — but not including — the holds-approver-rule migration.
  runMigrations(
    db,
    migrations.filter((m) => !['holds-approver-rule', 'approval-holds-view'].includes(m.name)),
  );
});

afterEach(() => {
  closeDb();
});

function hasTable(name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function hasView(name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?").get(name) !== undefined;
}

describe('migration 020 — holds-approver-rule', () => {
  it('backfills approver_rule and agent_group_id on in-flight rows and drops the sender table', () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-1', 'One', 'one', ?)").run(now);
    db.prepare(
      "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, created_at) VALUES ('sess-1', 'ag-1', NULL, NULL, ?)",
    ).run(now);

    // Legacy a2a hold: named approver ⇒ was exclusive.
    db.prepare(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, approver_user_id, title, options_json)
       VALUES ('appr-a2a', 'sess-1', 'appr-a2a', 'a2a_message_gate', '{}', ?, 'tg:dana', '', '[]')`,
    ).run(now);
    // Legacy cli hold: no approver, no agent_group_id — click-auth fell back
    // to the session's group; the backfill makes that anchoring explicit.
    db.prepare(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, title, options_json)
       VALUES ('appr-cli', 'sess-1', 'appr-cli', 'cli_command', '{}', ?, '', '[]')`,
    ).run(now);
    // Legacy OneCLI hold: sessionless, agent_group_id already stamped.
    db.prepare(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, agent_group_id, title, options_json)
       VALUES ('oa-1', NULL, 'req-uuid', 'onecli_credential', '{}', ?, 'ag-1', '', '[]')`,
    ).run(now);

    expect(hasTable('pending_sender_approvals')).toBe(true);

    runMigrations(db); // applies the hold contract and its unified read view

    const rows = db.prepare('SELECT approval_id, approver_rule, agent_group_id FROM pending_approvals').all() as Array<{
      approval_id: string;
      approver_rule: string;
      agent_group_id: string;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.approval_id, r]));

    expect(byId['appr-a2a']).toMatchObject({
      approver_rule: 'exclusive',
      agent_group_id: 'ag-1',
    });
    expect(byId['appr-cli']).toMatchObject({
      approver_rule: 'admins-of-scope',
      agent_group_id: 'ag-1',
    });
    expect(byId['oa-1']).toMatchObject({ approver_rule: 'admins-of-scope', agent_group_id: 'ag-1' });

    expect(hasTable('pending_sender_approvals')).toBe(false);
  });

  it('the dedup_key partial UNIQUE keeps at most one in-flight hold per key (sender fold parity)', () => {
    runMigrations(db);
    const now = new Date().toISOString();
    const insert = (id: string, key: string | null) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO pending_approvals
             (approval_id, request_id, action, payload, created_at, title, options_json, dedup_key)
           VALUES (?, ?, 'sender_admit', '{}', ?, '', '[]', ?)`,
        )
        .run(id, id, now, key).changes;

    expect(insert('a', 'sender_admit:mg:tg:stranger')).toBe(1);
    expect(insert('b', 'sender_admit:mg:tg:stranger')).toBe(0); // same key → dropped by the partial UNIQUE
    // NULL keys are exempt (the partial index), so ordinary holds still coexist.
    expect(insert('c', null)).toBe(1);
    expect(insert('d', null)).toBe(1);
  });

  it('exposes pending_approvals and channel registrations through one read model', () => {
    runMigrations(db);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-1', 'One', 'one', ?)").run(now);
    db.prepare(
      `INSERT INTO messaging_groups
         (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES ('mg-1', 'telegram', 'telegram', 'chat-1', 'Chat', 1, 'request_approval', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO pending_approvals
         (approval_id, request_id, action, payload, created_at, agent_group_id, title, options_json)
       VALUES ('appr-1', 'appr-1', 'install_packages', '{}', ?, 'ag-1', 'Install', '[]')`,
    ).run(now);
    db.prepare(
      `INSERT INTO pending_channel_approvals
         (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at, title, options_json)
       VALUES ('mg-1', 'ag-1', '{}', 'telegram:owner', ?, 'Register', '[]')`,
    ).run(now);

    expect(hasView('approval_holds')).toBe(true);
    const rows = db
      .prepare(
        `SELECT approval_id, action, agent_group_id, approver_user_id, approver_rule
           FROM approval_holds ORDER BY approval_id`,
      )
      .all();
    expect(rows).toEqual([
      {
        approval_id: 'appr-1',
        action: 'install_packages',
        agent_group_id: 'ag-1',
        approver_user_id: null,
        approver_rule: 'admins-of-scope',
      },
      {
        approval_id: 'mg-1',
        action: 'channel_registration',
        agent_group_id: 'ag-1',
        approver_user_id: 'telegram:owner',
        approver_rule: 'admins-of-scope',
      },
    ]);
  });
});
