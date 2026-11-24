import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { attributionHeaders, LlmRuntime } from '@deepseek-ai/dsh-llm';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import AuthorizationService from '@deepseek-ai/dsh-authorization';
import { AntigravityAdapter } from '../dist/index.js';
import * as plugin from '../dist/index.js';

test('built package mounts and unloads in real Cordis services without a TypeScript loader', async () => {
  const home = await mkdtemp(join(process.cwd(), '.smoke-'));
  const ctx = new Context();
  try {
    await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false });
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(AuthorizationService);
    const fiber = ctx.plugin(plugin, { maxPageChars: 60000 });
    await fiber;
    assert(ctx.llm.listProviders().some((provider) => provider.id === 'antigravity'));
    assert(ctx.authorization.list().some((flow) => flow.key === 'dsh-antigravity/antigravity'));
    assert.deepEqual(await ctx.llm.listModels('antigravity'), []);
    await fiber.dispose();
    assert(!ctx.llm.listProviders().some((provider) => provider.id === 'antigravity'));
    assert(!ctx.authorization.list().some((flow) => flow.key === 'dsh-antigravity/antigravity'));
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test('built plugin makes native streaming requests with DSH attribution and no credit overages', async () => {
  const originalFetch = globalThis.fetch;
  const previous = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('ANTIGRAVITY_') || name.startsWith('NOAGY_')) delete process.env[name];
  }
  process.env.ANTIGRAVITY_NO_PREWARM = '1';
  // The bundled adapter must ignore this Pi/CLI overage preference.
  process.env.ANTIGRAVITY_USE_CREDITS = '1';
  let wire;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-access');
    for (const [name, value] of Object.entries(attributionHeaders()))
      assert(headers.get(name)?.includes(value));
    assert(headers.get('user-agent').startsWith('antigravity/cli/'));
    if (url.includes('fetchAvailableModels'))
      return Response.json({
        models: {
          'gemini-3.8-flash-low': {
            displayName: 'Gemini 3.8 Flash Low',
            supportsThinking: true,
            supportsImages: true,
          },
        },
      });
    assert(url.includes('streamGenerateContent'), `Unexpected endpoint: ${url}`);
    wire = JSON.parse(init.body);
    return new Response(
      'data: ' +
        JSON.stringify({
          response: {
            candidates: [
              { content: { parts: [{ text: 'Hello from Antigravity' }] }, finishReason: 'STOP' },
            ],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
          },
        }) +
        '\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  try {
    const apiKey = JSON.stringify({ token: 'test-access', projectId: 'test-project' });
    const adapter = new AntigravityAdapter(new Context(), {
      getApiKey: async () => apiKey,
      getSession: async () => ({ apiKey, accountId: 'test@example.com' }),
    });
    const models = await adapter.listModels('antigravity');
    assert(models.some((model) => model.id === 'gemini-3.8-flash'));
    const chunks = await Array.fromAsync(
      adapter.stream({
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello.' }] }],
      }),
    );
    assert(
      chunks.some(
        (chunk) => chunk.type === 'text-delta' && chunk.text === 'Hello from Antigravity',
      ),
      JSON.stringify(chunks),
    );
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(wire.project, 'test-project');
    assert.equal(wire.model, 'gemini-3.8-flash-low');
    assert.equal(wire.enabledCreditTypes, undefined);
    assert(
      wire.request.contents.some((message) =>
        message.parts.some((part) => part.text?.includes('Say hello.')),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
  }
});
