import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { test, type TestContext } from 'node:test';
import {
  getApiKey,
  loginAntigravity,
  refreshAntigravityToken,
  type OAuthCallbacks,
} from '../src/oauth.js';

function environment(t: TestContext, values: Record<string, string> = {}) {
  for (const name of [
    'ANTIGRAVITY_CLIENT_ID',
    'ANTIGRAVITY_CLIENT_SECRET',
    'ANTIGRAVITY_PROJECT_ID',
  ]) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
}

function callback(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    }).on('error', reject);
  });
}

const idlePrompt: OAuthCallbacks['onPrompt'] = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

test('desktop OAuth uses the configured public client, PKCE and state with a loopback callback', async (t) => {
  environment(t, { ANTIGRAVITY_CLIENT_ID: 'owned-desktop-client' });
  let authUrl: URL | undefined;
  let callbackResult: Promise<number> | undefined;
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      exchanges++;
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_id'), 'owned-desktop-client');
      assert.equal(body.has('client_secret'), false);
      assert.equal(body.get('code'), 'authorized-code');
      assert.equal(body.get('redirect_uri'), authUrl?.searchParams.get('redirect_uri'));
      const verifier = body.get('code_verifier')!;
      assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
      assert.equal(
        createHash('sha256').update(verifier).digest('base64url'),
        authUrl?.searchParams.get('code_challenge'),
      );
      assert.notEqual(authUrl?.searchParams.get('state'), verifier);
      assert.ok(init?.signal);
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    }
    if (String(url).includes('/userinfo')) return Response.json({ email: 'person@example.test' });
    assert.match(String(url), /:loadCodeAssist$/);
    return Response.json({ cloudaicompanionProject: { id: 'real-project' } });
  });
  const result = await loginAntigravity({
    onAuth({ url }) {
      authUrl = new URL(url);
      assert.equal(authUrl.origin, 'https://accounts.google.com');
      assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
      const redirect = new URL(authUrl.searchParams.get('redirect_uri')!);
      assert.equal(redirect.hostname, '127.0.0.1');
      assert.ok(Number(redirect.port) > 0);
      redirect.searchParams.set('state', 'wrong-state');
      redirect.searchParams.set('code', 'untrusted-code');
      callbackResult = callback(redirect.href).then(async (status) => {
        assert.equal(status, 400);
        redirect.searchParams.set('state', authUrl!.searchParams.get('state')!);
        redirect.searchParams.set('code', 'authorized-code');
        return callback(redirect.href);
      });
    },
    onPrompt: idlePrompt,
  });
  assert.equal(await callbackResult, 200);
  assert.equal(exchanges, 1);
  assert.deepEqual(
    { ...result, expires: 0 },
    {
      access: 'access',
      refresh: 'refresh',
      expires: 0,
      projectId: 'real-project',
      email: 'person@example.test',
      oauthClientId: 'owned-desktop-client',
    },
  );
  assert.ok(result.expires > Date.now());
});

test('manual callback retries invalid state without echoing input and sends only the configured secret', async (t) => {
  environment(t, {
    ANTIGRAVITY_CLIENT_ID: 'my-client',
    ANTIGRAVITY_CLIENT_SECRET: 'my-secret',
    ANTIGRAVITY_PROJECT_ID: 'explicit-project',
  });
  let authorization: URL;
  let prompts = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/userinfo')) return Response.json({});
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(new URLSearchParams(String(init?.body)).get('client_secret'), 'my-secret');
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
  });
  const result = await loginAntigravity({
    onAuth({ url }) {
      authorization = new URL(url);
    },
    async onPrompt({ message }) {
      assert.doesNotMatch(message, /private-code|my-secret/);
      const url = new URL(authorization.searchParams.get('redirect_uri')!);
      url.searchParams.set(
        'state',
        prompts++ === 0 ? 'other-login' : authorization.searchParams.get('state')!,
      );
      url.searchParams.set('code', 'private-code');
      return url.href;
    },
  });
  assert.equal(prompts, 2);
  assert.equal(result.projectId, 'explicit-project');
  assert.equal(result.email, undefined);
});

test('cancelling login closes the listener and pending prompt without a token exchange', async (t) => {
  environment(t, { ANTIGRAVITY_CLIENT_ID: 'my-client' });
  const controller = new AbortController();
  let redirect = '';
  let promptSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('cancelled login must not exchange a token'),
  );
  await assert.rejects(
    loginAntigravity({
      signal: controller.signal,
      onAuth({ url }) {
        redirect = new URL(url).searchParams.get('redirect_uri')!;
      },
      onPrompt(input) {
        promptSignal = input.signal;
        setImmediate(() => controller.abort());
        return idlePrompt(input);
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(promptSignal?.aborted, true);
  await assert.rejects(callback(redirect), { code: 'ECONNREFUSED' });
});

test('project discovery uses listed real projects and fails explicitly when none is available', async (t) => {
  environment(t, { ANTIGRAVITY_CLIENT_ID: 'my-client' });
  let available = true;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).endsWith('/token'))
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    if (String(url).includes('/userinfo')) return Response.json({});
    if (String(url).endsWith(':loadCodeAssist')) return Response.json({});
    assert.match(String(url), /:listCloudAICompanionProjects$/);
    return Response.json({ projects: available ? [{ projectId: 'listed-project' }] : [] });
  });
  const signIn = () => {
    let authUrl: URL;
    return loginAntigravity({
      onAuth({ url }) {
        authUrl = new URL(url);
      },
      async onPrompt() {
        const url = new URL(authUrl.searchParams.get('redirect_uri')!);
        url.searchParams.set('state', authUrl.searchParams.get('state')!);
        url.searchParams.set('code', 'code');
        return url.href;
      },
    });
  };
  assert.equal((await signIn()).projectId, 'listed-project');
  available = false;
  await assert.rejects(signIn(), /ANTIGRAVITY_PROJECT_ID/);
});

test('legacy grant refresh uses the original configured client and preserves project, email and refresh token', async (t) => {
  environment(t, { ANTIGRAVITY_CLIENT_ID: 'original-client' });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('client_id'), 'original-client');
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'legacy-refresh');
    assert.equal(body.has('client_secret'), false);
    return Response.json({ access_token: 'renewed-access', expires_in: 3600 });
  });
  const result = await refreshAntigravityToken({
    access: 'old',
    refresh: 'legacy-refresh',
    expires: 0,
    projectId: 'existing-project',
    email: 'person@example.test',
  });
  assert.deepEqual(
    { ...result, expires: 0 },
    {
      access: 'renewed-access',
      refresh: 'legacy-refresh',
      expires: 0,
      projectId: 'existing-project',
      email: 'person@example.test',
      oauthClientId: 'original-client',
    },
  );
});

test('missing or mismatched OAuth clients fail before I/O with actionable migration guidance', async (t) => {
  environment(t);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('invalid configuration must not send credentials'),
  );
  const credentials = {
    access: 'private-access',
    refresh: 'private-refresh',
    expires: 0,
    projectId: 'project',
  };
  await assert.rejects(
    loginAntigravity({ onAuth() {}, onPrompt: idlePrompt }),
    /ANTIGRAVITY_CLIENT_ID/,
  );
  await assert.rejects(refreshAntigravityToken(credentials), /same OAuth client/i);
  process.env.ANTIGRAVITY_CLIENT_ID = 'different-client';
  await assert.rejects(
    refreshAntigravityToken({ ...credentials, oauthClientId: 'original-client' }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /same OAuth client/i);
      assert.doesNotMatch(error.message, /private-access|private-refresh/);
      return true;
    },
  );
  assert.deepEqual(JSON.parse(getApiKey(credentials)), {
    token: 'private-access',
    projectId: 'project',
  });
  await assert.rejects(
    async () => getApiKey({ ...credentials, projectId: undefined }),
    /ANTIGRAVITY_PROJECT_ID/,
  );
});

test('OAuth rejection and malformed responses do not leak token endpoint payloads', async (t) => {
  environment(t, { ANTIGRAVITY_CLIENT_ID: 'my-client' });
  const credentials = {
    access: 'access',
    refresh: 'private-refresh',
    expires: 0,
    projectId: 'project',
  };
  let malformed = false;
  t.mock.method(globalThis, 'fetch', async () =>
    malformed
      ? new Response('{"access_token":"private-token" broken', { status: 200 })
      : Response.json(
          {
            error: 'invalid_grant',
            error_description: 'private-refresh http://127.0.0.1/?code=private-code',
          },
          { status: 400 },
        ),
  );
  await assert.rejects(refreshAntigravityToken(credentials), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /same OAuth client/i);
    assert.doesNotMatch(error.message, /private-refresh|private-code/);
    return true;
  });
  malformed = true;
  await assert.rejects(refreshAntigravityToken(credentials), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /response/i);
    assert.doesNotMatch(error.message, /private-token/);
    return true;
  });
});
