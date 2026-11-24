import { LlmError } from '@deepseek-ai/dsh-llm';

/** Decode lines incrementally so large image events aren't rescanned on every network chunk. */
async function* lines(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let fragments: string[] = [];
  let afterCR = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      const chunk = decoder.decode(value, { stream: !done });
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i];
        if (afterCR && char === '\n') {
          afterCR = false;
          start = i + 1;
          continue;
        }
        afterCR = char === '\r';
        if (!afterCR && char !== '\n') continue;
        fragments.push(chunk.slice(start, i));
        yield fragments.join('');
        fragments = [];
        start = i + 1;
      }
      if (start < chunk.length) fragments.push(chunk.slice(start));
      if (done) break;
    }
    if (fragments.length) yield fragments.join('');
    yield '';
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* sseJson(response: Response, signal: AbortSignal): AsyncGenerator<unknown> {
  if (!response.body) throw new LlmError('Empty streaming response', 'EMPTY_RESPONSE');
  let fields: string[] = [];
  for await (const line of lines(response.body, signal)) {
    if (line === '' && fields.length) {
      const data = fields.join('\n');
      fields = [];
      if (data.trim() === '[DONE]') return;
      let object: unknown;
      try {
        object = JSON.parse(data);
      } catch {
        throw new LlmError('Invalid JSON in a streaming event', 'MALFORMED_RESPONSE');
      }
      yield object;
    } else if (line.startsWith('data:') || line === 'data') {
      fields.push(line.slice(5).replace(/^ /, ''));
    }
  }
}
