import { describe, it, expect } from 'bun:test';

import { autoAnswerQuestion, drainPendingQuestions, QUESTION_STEERING_TEXT, type QuestionClient } from './opencode.js';

/**
 * Fake `/v2` question client — captures every reply/list call so tests can
 * assert what OpenCodeProvider sends back without spawning a real server.
 * This simulates the `question.asked` event path end to end: a caller hands
 * this fake the same `{ id, sessionID, questions }` shape the real SSE
 * stream would deliver in its `properties`, and we assert the auto-answer
 * that goes out the other side.
 */
function createFakeQuestionClient(opts: {
  pending?: Array<{ id: string; sessionID?: string; questions?: unknown[] }>;
  replyError?: unknown;
} = {}): { client: QuestionClient; replyCalls: Array<{ requestID: string; answers: string[][] }> } {
  const replyCalls: Array<{ requestID: string; answers: string[][] }> = [];
  const client: QuestionClient = {
    question: {
      async reply(params) {
        replyCalls.push(params);
        if (opts.replyError) return { error: opts.replyError };
        return { data: true };
      },
      async list() {
        return { data: opts.pending ?? [] };
      },
    },
  };
  return { client, replyCalls };
}

describe('autoAnswerQuestion', () => {
  it('replies with one steering-text answer per sub-question — the wedge-path fix', async () => {
    const { client, replyCalls } = createFakeQuestionClient();

    // Simulates a `question.asked` event's properties for a two-part question.
    await autoAnswerQuestion(client, {
      id: 'que_f931faf310018jM9tBPKPMsezK',
      questions: [{ question: 'Proceed with deletion?' }, { question: 'Which target?' }],
    });

    expect(replyCalls).toEqual([
      {
        requestID: 'que_f931faf310018jM9tBPKPMsezK',
        answers: [[QUESTION_STEERING_TEXT], [QUESTION_STEERING_TEXT]],
      },
    ]);
  });

  it('answers with a single steering-text entry when the question count is unknown', async () => {
    const { client, replyCalls } = createFakeQuestionClient();

    await autoAnswerQuestion(client, { id: 'que_no_questions_array' });

    expect(replyCalls).toEqual([{ requestID: 'que_no_questions_array', answers: [[QUESTION_STEERING_TEXT]] }]);
  });

  it('steers the model toward autonomy or the real ask_user_question MCP tool', async () => {
    const { client, replyCalls } = createFakeQuestionClient();
    await autoAnswerQuestion(client, { id: 'que_1', questions: [{}] });
    const [{ answers }] = replyCalls;
    expect(answers[0][0]).toContain('ask_user_question');
    expect(answers[0][0].toLowerCase()).toContain('not available in this environment');
  });

  it('never throws — a failed reply must not take the session down with it', async () => {
    const { client } = createFakeQuestionClient({ replyError: { message: 'boom' } });
    await expect(autoAnswerQuestion(client, { id: 'que_err', questions: [{}] })).resolves.toBeUndefined();
  });

  it('is a no-op without a request id', async () => {
    const { client, replyCalls } = createFakeQuestionClient();
    await autoAnswerQuestion(client, {});
    expect(replyCalls).toEqual([]);
  });
});

describe('drainPendingQuestions', () => {
  it('answers every question already pending when the runtime starts', async () => {
    const { client, replyCalls } = createFakeQuestionClient({
      pending: [
        { id: 'que_a', sessionID: 'ses_1', questions: [{}] },
        { id: 'que_b', sessionID: 'ses_2', questions: [{}, {}] },
      ],
    });

    await drainPendingQuestions(client);

    expect(replyCalls.map((c) => c.requestID)).toEqual(['que_a', 'que_b']);
    expect(replyCalls[1].answers).toHaveLength(2);
  });

  it('does nothing when there are no pending questions', async () => {
    const { client, replyCalls } = createFakeQuestionClient({ pending: [] });
    await drainPendingQuestions(client);
    expect(replyCalls).toEqual([]);
  });

  it('never throws when listing itself fails', async () => {
    const client: QuestionClient = {
      question: {
        reply: async () => ({ data: true }),
        list: async () => {
          throw new Error('connection reset');
        },
      },
    };
    await expect(drainPendingQuestions(client)).resolves.toBeUndefined();
  });
});
