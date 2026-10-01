/**
 * A local fake of an OpenAI-compatible endpoint (the shape vLLM serves), for tests only. Not
 * exported from the package index; tests import this path directly, and no app may (contract test).
 *
 * ENG-20's tests must exercise the real HTTP path — headers, timeouts, retries, bodies — without
 * touching any real network or the pod. This listens on 127.0.0.1 on an ephemeral port and answers
 * from a script the test supplies, recording every request it receives.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

export type FakeAnswer =
  | { readonly status: number; readonly json: unknown }
  | { readonly status: number; readonly raw: string }
  /** Never answer; the client's timeout must fire. */
  | { readonly hang: true }
  /** Close the socket without an HTTP answer. */
  | { readonly destroy: true };

export interface FakeOpenAiServer {
  /** `http://127.0.0.1:<port>/v1` — the shape ONE_AI_BASE_URL takes. */
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/** A well-formed chat completion with token usage, as vLLM returns it. */
export function completion(text: string, usage = { prompt_tokens: 120, completion_tokens: 40 }, finishReason = 'stop', model = 'fake/served-model'): unknown {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
}

/**
 * `answer` is called once per request with its zero-based index, so a test can script
 * "503, then 503, then success".
 */
export async function startFakeOpenAiServer(answer: (request: RecordedRequest, index: number) => FakeAnswer): Promise<FakeOpenAiServer> {
  const requests: RecordedRequest[] = [];
  const hanging = new Set<ServerResponse>();
  const server: Server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const recorded: RecordedRequest = {
        method: incoming.method ?? '',
        path: incoming.url ?? '',
        authorization: incoming.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const scripted = answer(recorded, requests.length - 1);
      if ('hang' in scripted) { hanging.add(response); return; }
      if ('destroy' in scripted) { incoming.socket.destroy(); return; }
      const body = 'json' in scripted ? JSON.stringify(scripted.json) : scripted.raw;
      response.writeHead(scripted.status, { 'content-type': 'json' in scripted ? 'application/json' : 'text/plain' });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      for (const response of hanging) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
