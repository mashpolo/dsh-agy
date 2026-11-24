import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sseJson } from '../src/sse.js';

test('SSE decodes split UTF-8, CRLF and multiline events, and releases the response on DONE', async () => {
  const bytes = new TextEncoder().encode(
    ': ping\r\ndata: {"s":\r\ndata: "你好"}\r\n\r\ndata: [DONE]\r\n\r\n',
  );
  let stopped = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of bytes) controller.enqueue(Uint8Array.of(b));
    },
    cancel() {
      stopped = true;
    },
  });
  assert.deepEqual(
    await Array.fromAsync(sseJson(new Response(body), new AbortController().signal)),
    [{ s: '你好' }],
  );
  assert.equal(stopped, true);
});

test('abort releases a stalled streaming reader', async () => {
  let stopped = false;
  const ctl = new AbortController();
  const iter = sseJson(
    new Response(
      new ReadableStream({
        cancel() {
          stopped = true;
        },
      }),
    ),
    ctl.signal,
  );
  const reading = iter.next();
  ctl.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(stopped, true);
});
