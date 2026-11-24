import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import {
  AttachmentStore,
  AttachmentId,
  ImageVariantId,
  type ImageAttachmentRef,
  type ImageRequestTarget,
  type RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment';
import {
  LlmError,
  MessageId,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm';
import { AntigravityAdapter, type Backend } from '../src/provider.js';

const auth = {
  getApiKey: async () => JSON.stringify({ token: 'key', projectId: 'project' }),
  getSession: async () => ({ apiKey: await auth.getApiKey(), accountId: 'test@example.com' }),
};
const catalog = {
  data: {
    models: {
      'gemini-test-low': {
        displayName: 'Test Gemini Low',
        supportsThinking: true,
        supportsImages: true,
        maxInputTokens: 100000,
        maxOutputTokens: 8192,
      },
      'gemini-test-high': {
        displayName: 'Test Gemini High',
        supportsThinking: true,
        supportsImages: true,
        maxInputTokens: 100000,
        maxOutputTokens: 8192,
      },
    },
  },
};
function response() {
  return sse({
    response: {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Check a file', thought: true, thoughtSignature: 'signed-thinking' },
              {
                functionCall: { id: 'call-1', name: 'read_file', args: { path: 'a.ts' } },
                thoughtSignature: 'signed-call',
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 2,
        cachedContentTokenCount: 2,
        totalTokenCount: 18,
      },
    },
  });
}
function sse(...events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
const request: GenerateOptions = {
  provider: 'antigravity',
  model: 'gemini-test',
  system: 'Be helpful.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Read a.ts' }] }],
  tools: [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ],
  reasoningEffort: ReasoningEffortId('high'),
  maxTokens: 1000,
};
function backend(overrides: Partial<Backend> = {}): Backend {
  return { discover: async () => catalog, post: async () => response(), ...overrides };
}

test('discovers models once, exposes supported reasoning, and refreshes on invalidation', async () => {
  let discoveries = 0;
  const adapter = new AntigravityAdapter(
    new Context(),
    auth,
    backend({
      discover: async () => {
        discoveries++;
        return catalog;
      },
    }),
  );
  assert.equal((await adapter.listModels('antigravity'))[0].id, 'gemini-test');
  const resolved = await adapter.resolveModel('antigravity', 'gemini-test');
  assert.deepEqual(
    resolved.reasoning?.efforts.map((e) => e.id),
    ['low', 'high'],
  );
  assert.equal(resolved.context?.contextWindow, 100000);
  assert.equal(discoveries, 1);
  adapter.invalidate();
  await adapter.listModels('antigravity');
  assert.equal(discoveries, 2);
  assert.equal(
    (await adapter.resolveModel('antigravity', 'gemini-test-high')).id,
    'gemini-test-high',
  );
});

test('streams native reasoning and tool calls, then replays signatures and the matching result', async () => {
  const wires: Record<string, any>[] = [];
  const adapter = new AntigravityAdapter(
    new Context(),
    auth,
    backend({
      post: async (method, body, token, signal, options) => {
        assert.equal(method, 'streamGenerateContent');
        assert.equal(token, 'key');
        assert.equal(options?.stream, true);
        assert(!signal.aborted);
        wires.push(body as Record<string, any>);
        return response();
      },
    }),
  );
  const chunks = await Array.fromAsync(adapter.stream(request));
  assert(chunks.some((c) => c.type === 'reasoning-delta' && c.text === 'Check a file'));
  const finish = chunks.find((c) => c.type === 'finish');
  assert(finish?.type === 'finish');
  assert.deepEqual(finish.reason, { kind: 'tool-calls' });
  assert.deepEqual(
    chunks.find((c) => c.type === 'usage'),
    {
      type: 'usage',
      usage: {
        inputTokens: 10,
        outputTokens: 6,
        cacheReadTokens: 2,
        reasoningTokens: 2,
        totalTokens: 18,
      },
    },
  );
  const blocks = chunks.filter((c) => c.type === 'block-end').map((c) => c.block);
  await Array.fromAsync(
    adapter.stream({
      ...request,
      messages: [
        ...request.messages,
        {
          id: MessageId('a1'),
          role: 'assistant',
          content: blocks,
          source: {
            kind: 'model',
            provider: 'antigravity',
            model: 'gemini-test',
            replayState: finish.replayState,
          },
        },
        {
          id: MessageId('t1'),
          role: 'tool',
          toolCallId: ToolCallId('call-1'),
          source: { kind: 'tool', callId: ToolCallId('call-1') },
          content: [{ type: 'text', text: 'file content' }],
        },
      ],
    }),
  );
  assert.equal(wires[0].project, 'project');
  assert.equal(wires[0].model, 'gemini-test-high');
  assert.equal(wires[0].request.systemInstruction.parts[0].text, 'Be helpful.');
  assert.equal(wires[0].request.generationConfig.maxOutputTokens, 1000);
  assert.equal(wires[0].request.tools[0].functionDeclarations[0].name, 'read_file');
  assert.deepEqual(wires[1].request.contents[1].parts, [
    { text: 'Check a file', thought: true, thoughtSignature: 'signed-thinking' },
    {
      functionCall: { id: 'call-1', name: 'read_file', args: { path: 'a.ts' } },
      thoughtSignature: 'signed-call',
    },
  ]);
  assert.equal(wires[1].request.contents[2].parts[0].functionResponse.name, 'read_file');
  assert.equal(
    wires[1].request.contents[2].parts[0].functionResponse.response.output,
    'file content',
  );
});

test('replays old Pi signatures without a Pi runtime and degrades foreign-model signatures', async () => {
  let wire: any;
  const adapter = new AntigravityAdapter(
    new Context(),
    auth,
    backend({
      post: async (_method, body) => {
        wire = body;
        return response();
      },
    }),
  );
  const assistant = {
    id: MessageId('old'),
    role: 'assistant' as const,
    content: [
      { type: 'reasoning' as const, text: 'Prior thought' },
      {
        type: 'tool-call' as const,
        id: ToolCallId('old-call'),
        name: 'read_file',
        arguments: '{"path":"old.ts"}',
      },
    ],
    source: {
      kind: 'model' as const,
      provider: 'antigravity',
      model: 'gemini-test',
      replayState: {
        response: {
          kind: 'pi-ai',
          version: 2,
          api: 'antigravity-api',
          provider: 'antigravity',
          model: 'gemini-test',
          stopReason: 'toolUse',
        },
        blocks: [
          { type: 'reasoning', thinkingSignature: 'legacy-thinking' },
          { type: 'tool-call', thoughtSignature: 'legacy-call' },
        ],
      },
    },
  };
  const tool = {
    id: MessageId('result'),
    role: 'tool' as const,
    toolCallId: ToolCallId('old-call'),
    source: { kind: 'tool' as const, callId: ToolCallId('old-call') },
    content: [{ type: 'text' as const, text: 'old result' }],
  };
  await Array.fromAsync(
    adapter.stream({ ...request, messages: [...request.messages, assistant, tool] }),
  );
  assert.equal(wire.request.contents[1].parts[0].thoughtSignature, 'legacy-thinking');
  assert.equal(wire.request.contents[1].parts[1].thoughtSignature, 'legacy-call');
  await Array.fromAsync(
    adapter.stream({
      ...request,
      messages: [
        ...request.messages,
        { ...assistant, source: { ...assistant.source, model: 'other-model' } },
        tool,
      ],
    }),
  );
  assert(!JSON.stringify(wire).includes('legacy-call'));
  assert(!JSON.stringify(wire).includes('functionCall'));
  assert(JSON.stringify(wire).includes('old result'));
});

test('propagates cancellation and aborts the request when the consumer stops', async () => {
  let signal: AbortSignal | undefined;
  const adapter = new AntigravityAdapter(
    new Context(),
    auth,
    backend({
      post: async (_m, _b, _t, value) => {
        signal = value;
        return response();
      },
    }),
  );
  for await (const _chunk of adapter.stream(request)) break;
  assert.equal(signal?.aborted, true);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(Array.fromAsync(adapter.stream({ ...request, signal: abort.signal })), {
    name: 'AbortError',
  });
});

test('rejects unsupported stop sequences before sending inference', async () => {
  let called = false;
  const adapter = new AntigravityAdapter(
    new Context(),
    auth,
    backend({
      post: async () => {
        called = true;
        return response();
      },
    }),
  );
  await assert.rejects(Array.fromAsync(adapter.stream({ ...request, stop: ['STOP'] })), /stop/i);
  assert.equal(called, false);
});

test('token rotation preserves the directory, and a different account invalidates it', async () => {
  let accountId = 'first@example.com',
    token = 'first-token',
    discoveries = 0;
  const changingAuth = {
    ...auth,
    getSession: async () => ({
      accountId,
      apiKey: JSON.stringify({ token, projectId: 'shared-project' }),
    }),
  };
  const adapter = new AntigravityAdapter(
    new Context(),
    changingAuth,
    backend({
      discover: async () => {
        discoveries++;
        return catalog;
      },
    }),
  );
  await adapter.listModels('antigravity');
  token = 'refreshed-token';
  await adapter.listModels('antigravity');
  assert.equal(discoveries, 1);
  accountId = 'second@example.com';
  await adapter.listModels('antigravity');
  assert.equal(discoveries, 2);
});

test('a stale discovery cannot overwrite the newly signed-in account', async () => {
  let accountId = 'old@example.com',
    release!: (value: typeof catalog) => void,
    started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const adapter = new AntigravityAdapter(
    new Context(),
    { ...auth, getSession: async () => ({ accountId, apiKey: await auth.getApiKey() }) },
    backend({
      discover: async () => {
        if (accountId === 'old@example.com')
          return new Promise<typeof catalog>((resolve) => {
            release = resolve;
            started();
          });
        return { data: { models: { 'new-model': { displayName: 'New Model' } } } };
      },
    }),
  );
  const old = adapter.listModels('antigravity');
  await waiting;
  accountId = 'new@example.com';
  assert.equal((await adapter.listModels('antigravity'))[0].id, 'new-model');
  release(catalog);
  await assert.rejects(old, /credentials changed/);
  assert.equal((await adapter.listModels('antigravity'))[0].id, 'new-model');
});

test('cancellation returns promptly during a pending credential refresh', async () => {
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const adapter = new AntigravityAdapter(new Context(), {
    ...auth,
    getSession: () => {
      started();
      return new Promise(() => {});
    },
  });
  const controller = new AbortController();
  const pending = Array.fromAsync(adapter.stream({ ...request, signal: controller.signal }));
  await waiting;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('authorization failure clears cached models while a temporary failure retains them', async () => {
  let failure: LlmError | undefined;
  const adapter = new AntigravityAdapter(
    new Context(),
    auth,
    backend({
      discover: async () => {
        if (failure) throw failure;
        return catalog;
      },
    }),
  );
  assert.equal((await adapter.listModels('antigravity'))[0].id, 'gemini-test');
  failure = new LlmError('Temporary network failure', 'TRANSPORT');
  adapter.invalidate();
  assert.equal((await adapter.listModels('antigravity'))[0].id, 'gemini-test');
  failure = new LlmError('HTTP 403', 'AUTH', { status: 403 });
  adapter.invalidate();
  await assert.rejects(
    adapter.listModels('antigravity'),
    (error) => error instanceof LlmError && error.code === 'AUTH',
  );
  failure = new LlmError('Temporary network failure', 'TRANSPORT');
  assert.deepEqual(await adapter.listModels('antigravity'), []);
});

test('hides internal, tab, chat and image-only models from the conversation directory', async () => {
  const adapter = new AntigravityAdapter(
    new Context(),
    auth,
    backend({
      discover: async () => ({
        data: {
          models: {
            ...catalog.data.models,
            'internal-secret': { isInternal: true },
            tab_complete: {},
            chat_title: {},
            'imagen-4': {},
          },
        },
      }),
    }),
  );
  assert.deepEqual(
    (await adapter.listModels('antigravity')).map((model) => model.id),
    ['gemini-test'],
  );
});

test('honors recommended model groups and falls back when recommendations are unavailable', async () => {
  let recommended = ['missing-model', 'gemini-test-high'];
  const adapter = new AntigravityAdapter(
    new Context(),
    auth,
    backend({
      discover: async () => ({
        data: {
          models: { ...catalog.data.models, 'other-model': { displayName: 'Other Model' } },
          agentModelSorts: [{ groups: [{ modelIds: recommended }] }],
        },
      }),
    }),
  );
  assert.deepEqual(
    (await adapter.listModels('antigravity')).map((model) => model.id),
    ['gemini-test'],
  );
  assert.deepEqual(
    (await adapter.resolveModel('antigravity', 'gemini-test')).reasoning?.efforts.map((e) => e.id),
    ['low', 'high'],
  );
  recommended = ['missing-model'];
  adapter.invalidate();
  assert.deepEqual(
    (await adapter.listModels('antigravity')).map((model) => model.id),
    ['gemini-test', 'other-model'],
  );
});

test('uses DSH request-image variants and never rereads offloaded image bytes', async () => {
  let reads = 0;
  let wire: any;
  const image: ImageAttachmentRef = {
    attachmentId: AttachmentId('sha256:example'),
    mediaType: 'image/png',
    bytes: 20,
    width: 4000,
    height: 2000,
  };
  class Images extends AttachmentStore {
    readonly imageLimits = {
      maxImageBytes: 100,
      maxImagesPerMessage: 10,
      maxMessageImageBytes: 1000,
      maxImagePixels: 10000000,
      maxImageDimension: 10000,
      mediaTypes: ['image/png' as const],
    };
    async validateImage() {}
    async saveImage() {
      return image;
    }
    async readImage(): Promise<never> {
      throw new Error('Original image bytes must not be sent');
    }
    override async readImageRequest(
      ref: ImageAttachmentRef,
      target: ImageRequestTarget,
      signal?: AbortSignal,
    ): Promise<RequestImageAttachment> {
      reads++;
      assert(!signal?.aborted);
      assert(target.width * target.height <= 2048 * 2048);
      assert.equal(target.maxBytes, 1024 * 1024);
      return {
        variantId: ImageVariantId('variant-1'),
        attachment: ref,
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
        bytes: 3,
        width: target.width,
        height: target.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      };
    }
  }
  const ctx = new Context();
  await ctx.plugin(Images);
  try {
    const adapter = new AntigravityAdapter(
      ctx,
      auth,
      backend({
        post: async (_method, body) => {
          wire = body;
          return response();
        },
      }),
    );
    await Array.fromAsync(
      adapter.stream({
        ...request,
        messages: [{ role: 'user', content: [{ type: 'image', attachment: image }] }],
      }),
    );
    assert.equal(
      wire.request.contents[0].parts.find((part: any) => part.inlineData).inlineData.data,
      'AQID',
    );
    await Array.fromAsync(
      adapter.stream({
        ...request,
        messages: [
          { role: 'user', content: [{ type: 'image', attachment: image, offloaded: true }] },
        ],
      }),
    );
    assert.equal(reads, 1);
    assert(!JSON.stringify(wire).includes('inlineData'));
    assert(JSON.stringify(wire).includes('image omitted'));
  } finally {
    await ctx.fiber.dispose();
  }
});

test('handles split SSE bytes, comments, CRLF and repeated incremental text without losing content', async () => {
  const source =
    ': heartbeat\r\n\r\n' +
    [
      { candidates: [{ content: { parts: [{ text: '你' }] } }] },
      {
        candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join('');
  const bytes = new TextEncoder().encode(source);
  const adapter = new AntigravityAdapter(
    new Context(),
    auth,
    backend({
      post: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
        ),
    }),
  );
  const chunks = await Array.fromAsync(adapter.stream(request));
  assert.equal(
    chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text)
      .join(''),
    '你你好',
  );
  assert.equal(chunks.at(-1)?.type, 'finish');
});

test('rejects malformed protocol data, empty responses and premature stream EOF without leaking payloads', async () => {
  for (const reply of [
    new Response('data: {"private":"ya29.secret"\n\n'),
    sse({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }),
    sse({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
  ]) {
    const adapter = new AntigravityAdapter(
      new Context(),
      auth,
      backend({ post: async () => reply }),
    );
    await assert.rejects(Array.fromAsync(adapter.stream(request)), (error) => {
      assert(error instanceof Error);
      assert(!error.message.includes('ya29.secret'));
      return true;
    });
  }
});
