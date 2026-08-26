import { describe, expect, it } from 'vitest';
import {
  AssistantRateLimitedError,
  AssistantService,
  AssistantUnconfiguredError,
  buildSystemPrompt,
  selectArticles,
} from './assistant.service.js';

function sseBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const events = chunks.map((text) =>
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`);
  events.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
}

describe('assistant retrieval', () => {
  it('grounds a student assessment question in the assessment articles only', () => {
    const articles = selectArticles('student', 'why does the timer on my assessment show less than the window?');
    const ids = articles.map((article) => article.id);
    expect(ids).toContain('taking-assessments');
    expect(ids).not.toContain('exam-build-publish');
    expect(articles.length).toBeLessThanOrEqual(3);
  });

  it('keeps institution-only articles away from students', () => {
    const articles = selectArticles('student', 'how do I publish and assign an exam to students?');
    expect(articles.map((article) => article.id)).not.toContain('exam-build-publish');
  });

  it('gives institution staff the reopen and results guidance', () => {
    const ids = selectArticles('institution', 'how do I extend the window and see who has not attempted?').map((a) => a.id);
    expect(ids).toContain('exam-reopen-results');
  });

  it('falls back to orientation articles when nothing matches', () => {
    const ids = selectArticles('employer', 'zzzz qqqq xxxx').map((article) => article.id);
    expect(ids).toEqual(expect.arrayContaining(['navigation', 'getting-help']));
  });

  it('builds a prompt that carries the article text and the trust boundary', () => {
    const articles = selectArticles('employer', 'can I see candidate readiness scores?');
    const prompt = buildSystemPrompt('employer', articles);
    expect(prompt).toContain('employer workspace');
    expect(prompt).toContain('never employer-visible');
    for (const article of articles) expect(prompt).toContain(article.body);
  });
});

describe('assistant service', () => {
  it('refuses to stream without an API key', async () => {
    const service = new AssistantService({ apiKey: undefined, fetchImpl: (() => { throw new Error('must not be called'); }) as unknown as typeof fetch });
    // Guard against ambient env making this test lie.
    if (service.configured) return;
    await expect(service.streamChat({ persona: 'student', messages: [{ role: 'user', content: 'hi' }], onDelta: () => {} }))
      .rejects.toBeInstanceOf(AssistantUnconfiguredError);
  });

  it('enforces the daily cap per user', () => {
    const service = new AssistantService({ apiKey: 'test-key' });
    for (let i = 0; i < 40; i += 1) service.consumeAllowance('user-1');
    expect(() => service.consumeAllowance('user-1')).toThrow(AssistantRateLimitedError);
    expect(() => service.consumeAllowance('user-2')).not.toThrow();
  });

  it('assembles the streamed answer from SSE deltas and forwards each one', async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () => new Response(sseBody(['Open ', 'Assessments ', 'from the sidebar.']), { status: 200 })) as unknown as typeof fetch;
    const service = new AssistantService({ apiKey: 'test-key', fetchImpl });
    const answer = await service.streamChat({
      persona: 'student',
      messages: [{ role: 'user', content: 'where are my assessments?' }],
      onDelta: (text) => deltas.push(text),
    });
    expect(answer).toBe('Open Assessments from the sidebar.');
    expect(deltas).toEqual(['Open ', 'Assessments ', 'from the sidebar.']);
  });

  it('sends the grounded system prompt and the conversation to the API', async () => {
    let captured: { system?: string; messages?: readonly { role: string; content: string }[]; stream?: boolean } = {};
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      captured = JSON.parse(init.body);
      return new Response(sseBody(['ok']), { status: 200 });
    }) as unknown as typeof fetch;
    const service = new AssistantService({ apiKey: 'test-key', fetchImpl });
    await service.streamChat({
      persona: 'student',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Hi! How can I help with ONE?' },
        { role: 'user', content: 'why is my assessment window closed?' },
      ],
      onDelta: () => {},
    });
    expect(captured.stream).toBe(true);
    expect(captured.messages).toHaveLength(3);
    expect(captured.system).toContain('ONE Assistant');
    expect(captured.system).toContain('Window closed');
  });

  it('surfaces upstream failures as typed errors', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const service = new AssistantService({ apiKey: 'test-key', fetchImpl });
    await expect(service.streamChat({ persona: 'student', messages: [{ role: 'user', content: 'hi' }], onDelta: () => {} }))
      .rejects.toThrow('assistant upstream returned 500');
  });
});
