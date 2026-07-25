import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getPendingMessages } from '../db/messages-in.js';
import { extractAttachments } from '../formatter.js';
import { buildAttachmentFileParts, buildPromptParts } from './opencode.js';

/**
 * Channel attachments reach providers as prompt text (formatter.ts
 * formatAttachments). That stays, but text alone means a photo never actually
 * reaches a multimodal model. These cover the structured seam: extraction off
 * the message row, and the OpenCode file parts built from it.
 *
 * The `file://` URL form is load-bearing — OpenCode reads the path server-side
 * and inlines it as base64 itself (see buildAttachmentFileParts).
 */

const PRESENT = new Set([
  '/workspace/inbox/msg-1/cat.png',
  '/workspace/inbox/msg-1/report.pdf',
  '/workspace/inbox/msg-1/blob',
]);
const exists = (p: string): boolean => PRESENT.has(p);

describe('buildAttachmentFileParts', () => {
  it('sends an image as a file part with its mime and a file:// url', () => {
    const parts = buildAttachmentFileParts(
      [{ filename: 'cat.png', mime: 'image/png', path: '/workspace/inbox/msg-1/cat.png' }],
      exists,
    );
    expect(parts).toEqual([
      {
        type: 'file',
        mime: 'image/png',
        filename: 'cat.png',
        url: 'file:///workspace/inbox/msg-1/cat.png',
      },
    ]);
  });

  it('sends a PDF too — the backend may reject it, withholding it silently is worse', () => {
    const parts = buildAttachmentFileParts(
      [{ filename: 'report.pdf', mime: 'application/pdf', path: '/workspace/inbox/msg-1/report.pdf' }],
      exists,
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].mime).toBe('application/pdf');
    expect(parts[0].url).toBe('file:///workspace/inbox/msg-1/report.pdf');
  });

  it('falls back to the file extension when the adapter reported no mime', () => {
    const parts = buildAttachmentFileParts([{ filename: 'cat.PNG', path: '/workspace/inbox/msg-1/cat.png' }], exists);
    expect(parts).toHaveLength(1);
    expect(parts[0].mime).toBe('image/png');
  });

  it('adds nothing when there are no attachments, so parts stay text-only', () => {
    expect(buildAttachmentFileParts(undefined, exists)).toEqual([]);
    expect(buildAttachmentFileParts([], exists)).toEqual([]);
    // What the query generator actually spreads into the prompt body.
    expect([{ type: 'text', text: 'hi' }, ...buildAttachmentFileParts(undefined, exists)]).toEqual([
      { type: 'text', text: 'hi' },
    ]);
  });

  it('skips an attachment with no resolvable local file instead of throwing', () => {
    expect(() =>
      buildAttachmentFileParts(
        [
          { filename: 'gone.png', mime: 'image/png', path: '/workspace/inbox/msg-9/gone.png' },
          { filename: 'linked.png', mime: 'image/png', url: 'https://example.test/linked.png' },
        ],
        exists,
      ),
    ).not.toThrow();
    expect(
      buildAttachmentFileParts(
        [
          { filename: 'gone.png', mime: 'image/png', path: '/workspace/inbox/msg-9/gone.png' },
          { filename: 'linked.png', mime: 'image/png', url: 'https://example.test/linked.png' },
        ],
        exists,
      ),
    ).toEqual([]);
  });

  it('skips non-media attachments — the prompt text still describes them', () => {
    const parts = buildAttachmentFileParts(
      [
        { filename: 'notes.txt', mime: 'text/plain', path: '/workspace/inbox/msg-1/cat.png' },
        { filename: 'voice.ogg', mime: 'audio/ogg', path: '/workspace/inbox/msg-1/cat.png' },
        { filename: 'no-extension', path: '/workspace/inbox/msg-1/blob' },
      ],
      exists,
    );
    expect(parts).toEqual([]);
  });
});

/**
 * OpenCode keeps ONE query open per session, so after the first turn nearly
 * every real message arrives through AgentQuery.push rather than query(). The
 * prompt body for a push is built the same way as the opening one — otherwise
 * a photo sent as the second message reaches the model as prose only, and the
 * model confabulates a description of a picture it never saw (observed live).
 */
describe('buildPromptParts', () => {
  it('carries an image on a follow-up push, not just the opening query', () => {
    const parts = buildPromptParts(
      'what is in this photo?',
      [{ filename: 'cat.png', mime: 'image/png', path: '/workspace/inbox/msg-1/cat.png' }],
      exists,
    );
    expect(parts).toEqual([
      { type: 'text', text: 'what is in this photo?' },
      {
        type: 'file',
        mime: 'image/png',
        filename: 'cat.png',
        url: 'file:///workspace/inbox/msg-1/cat.png',
      },
    ]);
  });

  it('stays text-only when the push has no attachments', () => {
    expect(buildPromptParts('just words', undefined, exists)).toEqual([{ type: 'text', text: 'just words' }]);
    expect(buildPromptParts('just words', [], exists)).toEqual([{ type: 'text', text: 'just words' }]);
  });

  it('keeps the text part first and skips media it cannot resolve', () => {
    const parts = buildPromptParts(
      'two files',
      [
        { filename: 'gone.png', mime: 'image/png', path: '/workspace/inbox/msg-9/gone.png' },
        { filename: 'report.pdf', mime: 'application/pdf', path: '/workspace/inbox/msg-1/report.pdf' },
      ],
      exists,
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'two files' });
    expect(parts[1]).toMatchObject({ type: 'file', mime: 'application/pdf' });
  });
});

describe('extractAttachments', () => {
  beforeEach(() => {
    initTestSessionDb();
  });

  afterEach(() => {
    closeSessionDb();
  });

  function insertChat(id: string, content: object): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES (?, 'chat', ?, 'pending', ?)`,
      )
      .run(id, new Date().toISOString(), JSON.stringify(content));
  }

  it('resolves localPath against /workspace and carries mime through', () => {
    insertChat('m1', {
      text: 'look',
      attachments: [{ type: 'image', name: 'cat.png', mimeType: 'image/png', localPath: 'inbox/m1/cat.png' }],
    });
    const attachments = extractAttachments(getPendingMessages());
    expect(attachments).toEqual([
      { filename: 'cat.png', mime: 'image/png', path: '/workspace/inbox/m1/cat.png', url: undefined },
    ]);
  });

  it('returns nothing for a message with no attachments', () => {
    insertChat('m1', { text: 'just words' });
    expect(extractAttachments(getPendingMessages())).toEqual([]);
  });

  it('collects across every message in the batch', () => {
    insertChat('m1', {
      text: 'a',
      attachments: [{ name: 'a.png', mimeType: 'image/png', localPath: 'inbox/m1/a.png' }],
    });
    insertChat('m2', {
      text: 'b',
      attachments: [{ name: 'b.pdf', mimeType: 'application/pdf', localPath: 'inbox/m2/b.pdf' }],
    });
    const attachments = extractAttachments(getPendingMessages());
    expect(attachments.map((a) => a.path)).toEqual(['/workspace/inbox/m1/a.png', '/workspace/inbox/m2/b.pdf']);
  });

  it('keeps a url-only attachment (no staged file) so the provider can decide', () => {
    insertChat('m1', { text: 'link', attachments: [{ name: 'remote.png', url: 'https://example.test/remote.png' }] });
    const attachments = extractAttachments(getPendingMessages());
    expect(attachments).toEqual([
      { filename: 'remote.png', mime: undefined, path: undefined, url: 'https://example.test/remote.png' },
    ]);
    expect(buildAttachmentFileParts(attachments, exists)).toEqual([]);
  });
});
