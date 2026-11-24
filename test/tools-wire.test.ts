import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { executeAntigravitySearch, generateAntigravityImageContent } from '../src/tool-api.js';
import { executeAntigravityWebFetch, validateFetchTarget } from '../src/web-page.js';

const session = {
  apiKey: JSON.stringify({ token: 'test-token', projectId: 'test-project' }),
  signal: new AbortController().signal,
};
function endpoint(
  t: TestContext,
  handler: (method: string, body: Record<string, any>) => Response,
) {
  return t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init && typeof init.body === 'string');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-token');
    return handler(String(url).split('v1internal:')[1], JSON.parse(init.body));
  });
}

test('search requests grounding and exposes only visible text and public citations', async (t) => {
  endpoint(t, (method, body) => {
    assert.equal(method, 'generateContent');
    assert.equal(body.project, 'test-project');
    assert.equal(body.model, 'gemini-3.5-flash-lite');
    assert.match(JSON.stringify(body.request.contents), /https:\/\/example.com\/docs/);
    assert.deepEqual(body.request.tools, [{ googleSearch: {} }, { urlContext: {} }]);
    assert.equal(body.request.generationConfig?.thinkingConfig, undefined);
    return Response.json({
      response: {
        candidates: [
          {
            content: { parts: [{ thought: true, text: 'internal' }, { text: 'Public answer' }] },
            groundingMetadata: {
              groundingChunks: [{ web: { title: 'Source', uri: 'https://example.com/docs' } }],
            },
          },
        ],
      },
    });
  });
  const answer = await executeAntigravitySearch({
    ...session,
    query: 'topic',
    urls: ['https://example.com/docs'],
  });
  assert.match(answer, /Public answer/);
  assert.match(answer, /https:\/\/example.com\/docs/);
  assert.doesNotMatch(answer, /internal/);
});

test('crawler validates rewritten URL, fetches empty cache live, and converts HTML', async (t) => {
  const calls: string[] = [];
  endpoint(t, (method, body) => {
    calls.push(method);
    if (method === 'rewriteUri') return Response.json({ redirectUri: 'https://example.org/page' });
    assert.equal(body.url, 'https://example.org/page');
    return Response.json(
      body.liveFetch
        ? { contentType: 'text/html', content: '<h1>Hello</h1><script>secret</script><p>Page</p>' }
        : {},
    );
  });
  const result = await executeAntigravityWebFetch({ ...session, url: 'https://example.com/page' });
  assert.equal(result.source, 'live');
  assert.match(result.content, /^# Hello/);
  assert.doesNotMatch(result.content, /secret/);
  assert.deepEqual(calls, ['rewriteUri', 'fetchFromTrawlerCache', 'fetchFromTrawlerCache']);
});

test('crawler rejects local redirects and encoded private addresses', async (t) => {
  for (const url of [
    'http://0177.0.0.1/',
    'http://[::ffff:7f00:1]/',
    'https://abc.local/',
    'https://user:pass@example.com/',
  ]) {
    assert.throws(() => validateFetchTarget(url));
  }
  const fetch = endpoint(t, () => Response.json({ redirectUri: 'http://127.0.0.1/secret' }));
  await assert.rejects(
    () => executeAntigravityWebFetch({ ...session, url: 'https://example.com/' }),
    /private|local/i,
  );
  assert.equal(fetch.mock.callCount(), 1);
});

test('image supports a missing unary method through SSE and preserves the reference and aspect ratio', async (t) => {
  const image = { data: 'AA==', mimeType: 'image/png' };
  const parts = [{ text: 'drawing' }, { inlineData: image }];
  endpoint(t, (method, body) => {
    assert.equal(body.model, 'gemini-3.1-flash-image');
    assert.deepEqual(body.request.contents[0].parts, [{ text: 'Draw' }, { inlineData: image }]);
    assert.equal(body.request.generationConfig.imageConfig.aspectRatio, '1:1');
    if (method === 'generateContent') return new Response('', { status: 404 });
    assert.equal(method, 'streamGenerateContent?alt=sse');
    return new Response(
      'data: ' + JSON.stringify({ response: { candidates: [{ content: { parts } }] } }) + '\n\n',
    );
  });
  const result = await generateAntigravityImageContent({
    ...session,
    prompt: 'Draw',
    aspectRatio: '1:1',
    inputImages: [image],
  });
  assert.deepEqual(result.images, [image]);
  assert.deepEqual(result.text, ['drawing']);
});

test('image and search stop after quota errors', async (t) => {
  const fetch = endpoint(t, () => new Response('', { status: 429 }));
  await assert.rejects(
    () => generateAntigravityImageContent({ ...session, prompt: 'Draw' }),
    /429/,
  );
  await assert.rejects(() => executeAntigravitySearch({ ...session, query: 'topic' }), /429/);
  assert.equal(fetch.mock.callCount(), 2);
});
