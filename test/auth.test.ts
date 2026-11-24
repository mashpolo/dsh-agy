import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization';
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials';
import { CREDENTIAL_KEY, createAuth, createLoginFlow } from '../src/auth.js';
import { OAuthError } from '../src/oauth.js';

const credentials = () => ({
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
  projectId: 'project-123',
});

function memoryStore(initial: CredentialRecord | undefined) {
  let record = initial;
  let writes = 0;
  let queue = Promise.resolve();
  const store: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'> = {
    async readRecord(key) {
      assert.equal(key, CREDENTIAL_KEY);
      return record;
    },
    async modifyRecord(key, mutate) {
      assert.equal(key, CREDENTIAL_KEY);
      const result = queue.then(async () => {
        const replacement = await mutate(record);
        if (replacement !== undefined) {
          record = replacement;
          writes += 1;
        }
        return record;
      });
      queue = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
  return { store, record: () => record, writes: () => writes };
}

test('reads the current valid grant without refreshing or writing', async () => {
  const memory = memoryStore({ kind: 'grant', payload: credentials() });
  const auth = createAuth(memory.store, async () => assert.fail('unexpected refresh'));
  assert.deepEqual(JSON.parse(await auth.getApiKey()), {
    token: 'access-token',
    projectId: 'project-123',
  });
  assert.equal(memory.writes(), 0);

  await memory.store.modifyRecord(CREDENTIAL_KEY, async () => ({
    kind: 'grant',
    payload: { ...credentials(), access: 'new-login-token' },
  }));
  assert.equal(JSON.parse(await auth.getApiKey()).token, 'new-login-token');
});

test('refreshes an expired grant once under the store lock for concurrent callers', async () => {
  const old = { ...credentials(), expires: 0 };
  const memory = memoryStore({ kind: 'grant', payload: old });
  const renewed = {
    ...old,
    access: 'renewed-access',
    refresh: 'rotated-refresh',
    expires: Date.now() + 60_000,
  };
  let refreshes = 0;
  const auth = createAuth(memory.store, async (current) => {
    assert.equal(current.refresh, 'refresh-token');
    refreshes += 1;
    return renewed;
  });

  const keys = await Promise.all(Array.from({ length: 12 }, () => auth.getApiKey()));
  assert.equal(refreshes, 1);
  assert.equal(memory.writes(), 1);
  assert.ok(keys.every((key) => JSON.parse(key).token === 'renewed-access'));
  assert.deepEqual(memory.record(), { kind: 'grant', payload: renewed });
});

test('session identity survives token refresh and changes after a different account signs in', async () => {
  const memory = memoryStore({
    kind: 'grant',
    payload: {
      ...credentials(),
      expires: 0,
      email: 'first@example.test',
    },
  });
  const auth = createAuth(memory.store, async (current) => ({
    ...current,
    access: 'renewed-access',
    expires: Date.now() + 60_000,
  }));
  const refreshed = await auth.getSession();
  assert.equal(refreshed.accountId, 'first@example.test');
  assert.equal(JSON.parse(refreshed.apiKey).token, 'renewed-access');
  await memory.store.modifyRecord(CREDENTIAL_KEY, async () => ({
    kind: 'grant',
    payload: { ...credentials(), email: 'second@example.test' },
  }));
  assert.equal((await auth.getSession()).accountId, 'second@example.test');

  await memory.store.modifyRecord(CREDENTIAL_KEY, async () => ({
    kind: 'grant',
    payload: credentials(),
  }));
  assert.equal((await auth.getSession()).accountId, 'project-123');
});

test('missing and malformed credentials fail with login guidance and no secret leakage', async () => {
  const invalid: Array<CredentialRecord | undefined> = [
    undefined,
    { kind: 'api-key', key: 'private-value' },
    { kind: 'grant', payload: 'private-value' },
    { kind: 'grant', payload: { ...credentials(), refresh: '' } },
    { kind: 'grant', payload: { ...credentials(), expires: Number.NaN } },
    { kind: 'grant', payload: { ...credentials(), access: 'private-value\n' } },
    { kind: 'grant', payload: { ...credentials(), projectId: 42 } },
  ];
  for (const record of invalid) {
    const auth = createAuth(memoryStore(record).store, async () =>
      assert.fail('unexpected refresh'),
    );
    await assert.rejects(auth.getApiKey(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /sign in/i);
      assert.doesNotMatch(error.message, /private-value|access-token|refresh-token/);
      return true;
    });
  }
});

test('a failed refresh leaves the previous grant intact and does not disclose its error payload', async () => {
  const record: CredentialRecord = { kind: 'grant', payload: { ...credentials(), expires: 0 } };
  const memory = memoryStore(record);
  const auth = createAuth(memory.store, async () => {
    throw new Error('server rejected refresh-token private-value');
  });
  await assert.rejects(auth.getApiKey(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /refresh/i);
    assert.doesNotMatch(error.message, /refresh-token|private-value/);
    return true;
  });
  assert.equal(memory.record(), record);
  assert.equal(memory.writes(), 0);
});

test('stored OAuth client identity is preserved and safe configuration errors remain actionable', async () => {
  const memory = memoryStore({
    kind: 'grant',
    payload: {
      ...credentials(),
      expires: 0,
      oauthClientId: 'owned-client',
    },
  });
  const auth = createAuth(memory.store, async (current) => {
    assert.equal(current.oauthClientId, 'owned-client');
    throw new OAuthError(
      'Set ANTIGRAVITY_CLIENT_ID to the same OAuth client that authorized this grant.',
      'OAUTH_CONFIG',
    );
  });
  await assert.rejects(auth.getSession(), /ANTIGRAVITY_CLIENT_ID.*same OAuth client/);
  assert.equal(memory.writes(), 0);
});

test(
  'CLI displays safe OAuth configuration guidance without exposing credentials',
  { timeout: 15_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-oauth-config-'));
    const authEntry = new URL('../src/auth.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `const {runLogin}=await import(${JSON.stringify(authEntry)}); await runLogin([]);`,
      ],
      {
        env: {
          ...process.env,
          DSH_HOME: home,
          ANTIGRAVITY_CLIENT_ID: '',
          ANTIGRAVITY_CLIENT_SECRET: 'private-config-secret',
        },
        stdio: 'pipe',
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(code, 1);
      assert.match(stderr, /ANTIGRAVITY_CLIENT_ID/);
      assert.doesNotMatch(stdout + stderr, /access-token|refresh-token|private-config-secret/);
    } finally {
      child.kill();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test('login forwards notices, commits a JSON grant, and withdraws the losing paste prompt', async () => {
  const notices: unknown[] = [];
  let committed: CredentialRecord | undefined;
  let promptSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const session: AuthorizationSession = {
    method: 'oauth',
    signal: controller.signal,
    notify: (notice) => {
      notices.push(notice);
    },
    prompt: async (prompt) => {
      assert.equal(prompt.kind, 'secret');
      promptSignal = prompt.signal;
      return new Promise<string>((_resolve, reject) => {
        prompt.signal?.addEventListener('abort', () => reject(new Error('prompt withdrawn')), {
          once: true,
        });
      });
    },
    commit: async (record) => {
      assert.equal(promptSignal?.aborted, true);
      committed = record;
    },
  };
  const flow = createLoginFlow(async (callbacks) => {
    assert.equal(callbacks.signal, controller.signal);
    callbacks.onAuth({
      url: 'https://accounts.google.com/example',
      instructions: 'Return to DeepSeek Harness; re-run dsh-antigravity-login if needed.',
    });
    void callbacks
      .onPrompt({ message: 'Paste callback', placeholder: 'http://localhost/callback' })
      .catch(() => {});
    return { ...credentials(), email: undefined };
  });

  await flow.run(session);
  assert.equal(flow.key, CREDENTIAL_KEY);
  assert.deepEqual(notices, [
    {
      message: 'Return to DeepSeek Harness; re-run dsh-antigravity-login if needed.',
      url: 'https://accounts.google.com/example',
    },
  ]);
  assert.equal(committed?.kind, 'grant');
  assert.deepEqual(JSON.parse(JSON.stringify(committed)), committed);
  assert.equal(promptSignal?.aborted, true);
  assert.equal(controller.signal.aborted, false);
});

test('cancelled login aborts its pending prompt and does not commit', async () => {
  const controller = new AbortController();
  let promptSignal: AbortSignal | undefined;
  const flow = createLoginFlow(async (callbacks) => {
    void callbacks.onPrompt({ message: 'Paste callback' }).catch(() => {});
    controller.abort();
    callbacks.signal?.throwIfAborted();
    return credentials();
  });
  await assert.rejects(
    flow.run({
      method: 'oauth',
      signal: controller.signal,
      notify: () => {},
      prompt: async (prompt) => {
        promptSignal = prompt.signal;
        return new Promise<string>((_resolve, reject) => {
          prompt.signal?.addEventListener('abort', () => reject(new Error('prompt withdrawn')), {
            once: true,
          });
        });
      },
      commit: async () => assert.fail('cancelled login must not commit'),
    }),
    { name: 'AbortError' },
  );
  assert.equal(promptSignal?.aborted, true);
});

test(
  'CLI login writes a grant readable by the official DSH credential provider',
  { timeout: 15_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-antigravity-auth-'));
    const value = { ...credentials(), email: 'test@example.test' };
    const entry = new URL('../src/auth.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `const { runLogin } = await import(${JSON.stringify(entry)}); await runLogin([], async () => (${JSON.stringify(value)}));`,
      ],
      { env: { ...process.env, DSH_HOME: home }, stdio: 'pipe' },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const ctx = new Context();
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(code, 0, stderr);
      assert.match(stderr, /sign-in complete/);
      assert.doesNotMatch(stdout + stderr, /access-token|refresh-token|test@example\.test/);
      await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false });
      const session = await createAuth(ctx.credentials).getSession();
      assert.equal(session.accountId, 'test@example.test');
      assert.deepEqual(JSON.parse(session.apiKey), {
        token: 'access-token',
        projectId: 'project-123',
      });
    } finally {
      child.kill();
      await ctx.fiber.dispose();
      await rm(home, { recursive: true, force: true });
    }
  },
);
