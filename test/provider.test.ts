import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import {
  MessageId,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context as PiContext,
} from '@earendil-works/pi-ai';
import { AntigravityAdapter, type Backend } from '../src/provider.js';

const auth = {
  getApiKey: async () => JSON.stringify({ token: 'key', projectId: 'project' }),
  getSession: async () => ({ apiKey: await auth.getApiKey(), accountId: 'test@example.com' }),
};

const catalog = {
  models: [
    {
      id: 'gemini-test',
      name: 'Test Gemini',
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: null,
        high: 'high',
        xhigh: null,
        max: null,
      },
      input: ['text', 'image'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 8192,
    },
  ],
  routing: { 'gemini-test': { defaultRequestId: 'gemini-test-high' } },
};

function response() {
  const message: AssistantMessage = {
    role: 'assistant',
    api: 'antigravity-api',
    provider: 'antigravity',
    model: 'gemini-test',
    timestamp: 1,
    stopReason: 'toolUse',
    content: [
      { type: 'thinking', thinking: 'Check a file', thinkingSignature: 'signed-thinking' },
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'read_file',
        arguments: { path: 'a.ts' },
        thoughtSignature: 'signed-call',
      },
    ],
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 16,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'thinking_start', contentIndex: 0, partial: message });
  stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'Check a file', partial: message });
  stream.push({ type: 'thinking_end', contentIndex: 0, content: 'Check a file', partial: message });
  stream.push({ type: 'toolcall_start', contentIndex: 1, partial: message });
  const call = message.content[1];
  assert.equal(call.type, 'toolCall');
  stream.push({ type: 'toolcall_end', contentIndex: 1, toolCall: call, partial: message });
  stream.push({ type: 'done', reason: 'toolUse', message });
  stream.end();
  return stream;
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

test('discovers models once, exposes supported reasoning, and refreshes on invalidation', async () => {
  let discoveries = 0;
  const backend: Backend = {
    discover: async () => {
      discoveries++;
      return catalog;
    },
    stream: response,
    applyCatalog() {},
  };
  const adapter = new AntigravityAdapter(new Context(), auth, backend);
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
});

test('streams reasoning and tool calls, then replays signatures and the matching tool result', async () => {
  const contexts: PiContext[] = [];
  const backend: Backend = {
    discover: async () => catalog,
    applyCatalog() {},
    stream(model, context, options) {
      assert.equal(model.provider, 'antigravity');
      assert.equal(options?.reasoning, 'high');
      assert.equal(options?.maxTokens, 1000);
      contexts.push(context);
      return response();
    },
  };
  const adapter = new AntigravityAdapter(new Context(), auth, backend);
  const chunks = await Array.fromAsync(adapter.stream(request));
  assert(chunks.some((c) => c.type === 'reasoning-delta' && c.text === 'Check a file'));
  const finish = chunks.find((c) => c.type === 'finish');
  assert(finish?.type === 'finish');
  assert.deepEqual(finish.reason, { kind: 'tool-calls' });
  const blocks = chunks.filter((c) => c.type === 'block-end').map((c) => c.block);
  const next: GenerateOptions = {
    ...request,
    messages: [
      ...request.messages,
      {
        id: MessageId('assistant-1'),
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
        id: MessageId('result-1'),
        role: 'tool',
        toolCallId: ToolCallId('call-1'),
        source: { kind: 'tool', callId: ToolCallId('call-1') },
        content: [{ type: 'text', text: 'file content' }],
      },
    ],
  };
  await Array.fromAsync(adapter.stream(next));
  assert.equal(contexts[0].systemPrompt, 'Be helpful.');
  assert.equal(contexts[0].tools?.[0].name, 'read_file');
  const replay = contexts[1].messages[1];
  assert.equal(replay.role, 'assistant');
  assert.deepEqual(replay.content, [
    { type: 'thinking', thinking: 'Check a file', thinkingSignature: 'signed-thinking' },
    {
      type: 'toolCall',
      id: 'call-1',
      name: 'read_file',
      arguments: { path: 'a.ts' },
      thoughtSignature: 'signed-call',
    },
  ]);
  assert.equal(contexts[1].messages[2].role, 'toolResult');
  assert.equal(contexts[1].messages[2].toolName, 'read_file');
});

test('propagates cancellation and aborts the upstream request if the consumer stops', async () => {
  let signal: AbortSignal | undefined;
  const backend: Backend = {
    discover: async () => catalog,
    applyCatalog() {},
    stream(_model, _context, options) {
      signal = options?.signal;
      return response();
    },
  };
  const adapter = new AntigravityAdapter(new Context(), auth, backend);
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
  const backend: Backend = {
    discover: async () => catalog,
    applyCatalog() {},
    stream() {
      called = true;
      return response();
    },
  };
  const adapter = new AntigravityAdapter(new Context(), auth, backend);
  await assert.rejects(Array.fromAsync(adapter.stream({ ...request, stop: ['STOP'] })), /stop/i);
  assert.equal(called, false);
});

test('token rotation preserves the directory, and a different account invalidates it', async () => {
  let accountId = 'first@example.com';
  let token = 'first-token';
  let discoveries = 0;
  const changingAuth = {
    ...auth,
    getSession: async () => ({
      accountId,
      apiKey: JSON.stringify({ token, projectId: 'shared-project' }),
    }),
  };
  const backend: Backend = {
    discover: async () => {
      discoveries++;
      return catalog;
    },
    stream: response,
    applyCatalog() {},
  };
  const adapter = new AntigravityAdapter(new Context(), changingAuth, backend);
  await adapter.listModels('antigravity');
  token = 'refreshed-token';
  await adapter.listModels('antigravity');
  assert.equal(discoveries, 1);
  accountId = 'second@example.com';
  await adapter.listModels('antigravity');
  assert.equal(discoveries, 2);
});

test('a stale discovery cannot overwrite the newly signed-in account', async () => {
  let accountId = 'old@example.com';
  let release!: (value: typeof catalog) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const newer = { ...catalog, models: [{ ...catalog.models[0], id: 'new-model' }] };
  const backend: Backend = {
    stream: response,
    applyCatalog() {},
    discover: async () => {
      if (accountId === 'old@example.com')
        return new Promise<typeof catalog>((resolve) => {
          release = resolve;
          started();
        });
      return newer;
    },
  };
  const adapter = new AntigravityAdapter(
    new Context(),
    { ...auth, getSession: async () => ({ accountId, apiKey: await auth.getApiKey() }) },
    backend,
  );
  const old = adapter.listModels('antigravity');
  await waiting;
  accountId = 'new@example.com';
  assert.equal((await adapter.listModels('antigravity'))[0].id, 'new-model');
  release(catalog);
  await assert.rejects(old, /credentials changed/);
  assert.equal((await adapter.listModels('antigravity'))[0].id, 'new-model');
});

test('cancellation returns promptly while a credential refresh is still pending', async () => {
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
