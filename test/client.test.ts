import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchAvailableModelsCatalog, postRpc } from '../src/client.js';

test('model discovery merges distinct endpoint catalogs', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)), { project: 'demo' });
    const model = url.includes('daily-') ? 'preview' : 'regular';
    return Response.json({ models: { [model]: { displayName: model } } });
  });
  const result = await fetchAvailableModelsCatalog('token', 'demo');
  assert.deepEqual(Object.keys(result.data.models).sort(), ['preview', 'regular']);
});

test('generation failure is redacted and never blindly retried', async (t) => {
  const wire = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('sensitive', { status: 503 }),
  );
  await assert.rejects(
    postRpc('generateContent', {}, 'token', new AbortController().signal),
    (error: Error) => error.message.includes('503') && !error.message.includes('sensitive'),
  );
  assert.equal(wire.mock.callCount(), 1);
});

test('model discovery preserves a permission denial reported by both endpoints', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }));
  await assert.rejects(fetchAvailableModelsCatalog('token', 'demo'), (error: Error) =>
    error.message.includes('403'),
  );
});

test('generation can use a model present only on the standard endpoint', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    url.includes('daily-') ? new Response(null, { status: 404 }) : Response.json({ ok: true }),
  );
  const result = await postRpc('generateContent', {}, 'token', new AbortController().signal);
  assert.deepEqual(await result.json(), { ok: true });
});
