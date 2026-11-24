import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createAuth, type Auth } from '../src/auth.js';
import { queryUsage } from '../src/usage.js';

const apiKey = JSON.stringify({ token: 'private-token', projectId: 'private-project' });
const auth: Auth = {
  getSession: async () => ({
    apiKey,
    accountId: 'person@example.test',
    email: 'person@example.test',
  }),
  getApiKey: async () => assert.fail('queryUsage must read the current session'),
};

function mockRpc(t: TestContext, quota: unknown, assist: unknown, catalog?: unknown) {
  const replies: Record<string, unknown> = {
    retrieveUserQuotaSummary: quota,
    loadCodeAssist: assist,
    fetchAvailableModels: catalog,
  };
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-token');
    const method = String(url).split(':').pop()!;
    assert.ok(Object.hasOwn(replies, method));
    const reply = replies[method];
    return reply === undefined || typeof reply === 'number'
      ? new Response(null, { status: typeof reply === 'number' ? reply : 403 })
      : Response.json(reply);
  });
}

test('quota data preserves account, plan and balances and orders each shared group by period', async (t) => {
  mockRpc(
    t,
    {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              displayName: 'Weekly Limit Remaining',
              remainingFraction: 0.75,
              resetTime: '2026-11-30T02:00:00Z',
            },
            {
              displayName: 'Five Hour Limit Remaining',
              remainingFraction: 0,
              resetTime: '2026-11-24T08:00:00Z',
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { displayName: 'Weekly Limit Remaining', remainingFraction: 0.0005 },
            { displayName: 'Five Hour Limit Remaining', remainingFraction: 1 },
          ],
        },
        {
          displayName: 'Gemini Experimental Pool',
          buckets: [{ displayName: 'Five Hour Limit Remaining', remainingFraction: 0.6 }],
        },
      ],
    },
    {
      paidTier: {
        name: 'Google AI Pro',
        id: 'g1-pro-tier',
        availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '0' }],
      },
      currentTier: { name: 'Free', availableCredits: [{ creditType: 'OTHER', creditAmount: 100 }] },
    },
  );
  const result = await queryUsage(auth, new AbortController().signal);
  assert.equal(result.email, 'person@example.test');
  assert.equal(result.plan, 'Google AI Pro');
  assert.equal(result.ok, true);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(
    result.rows.map((row) => row.shortLabel),
    [
      'Gemini 5h',
      'Gemini 周',
      'Claude/GPT 5h',
      'Claude/GPT 周',
      'Gemini Experimental Pool / Five Hour Limit Remaining',
    ],
  );
  assert.deepEqual(result.rows[0], {
    label: 'Gemini Models / Five Hour Limit Remaining',
    shortLabel: 'Gemini 5h',
    fraction: 0,
    resetAt: Date.parse('2026-11-24T08:00:00Z'),
  });
  assert.equal(result.rows[3].fraction, 0.0005);
  assert.equal(result.rows[3].resetAt, null);
  assert.equal(result.balance, 'AI credits 余额\nGOOGLE_ONE_AI  0');
  assert.doesNotMatch(JSON.stringify(result), /private-token|private-project|OTHER/);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('missing email stays empty and missing balance is not replaced by the minimum required amount', async (t) => {
  mockRpc(
    t,
    {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ displayName: 'Weekly Limit Remaining', resetTime: 'not-a-date' }],
        },
      ],
    },
    {
      currentTier: { id: 'free-tier' },
      availableCredits: [{ creditType: 'GOOGLE_ONE_AI', minimumCreditAmountForUsage: '50' }],
    },
  );
  const result = await queryUsage(
    {
      ...auth,
      getSession: async () => ({ apiKey, accountId: 'private-project' }),
    },
    new AbortController().signal,
  );
  assert.equal(result.email, null);
  assert.equal(result.plan, 'free-tier');
  assert.equal(result.rows[0].fraction, null);
  assert.equal(result.rows[0].resetAt, null);
  assert.equal(result.balance, 'AI credits 余额未返回');
  assert.doesNotMatch(JSON.stringify(result), /private-project|\b50\b/);
});

test('partial failures keep model quota, HTTP diagnostics and valid snake-case credit balances', async (t) => {
  mockRpc(
    t,
    403,
    { available_credits: [{ credit_type: 'GOOGLE_ONE_AI', credit_amount: '125.5' }] },
    {
      models: {
        flash: { displayName: 'Flash', quotaInfo: { remainingFraction: 0.25 } },
        hidden: { isInternal: true, quotaInfo: { remainingFraction: 1 } },
        chat_hidden: { quotaInfo: { remainingFraction: 1 } },
      },
    },
  );
  const result = await queryUsage(auth, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, [
    { label: 'Flash', shortLabel: 'Flash', fraction: 0.25, resetAt: null },
  ]);
  assert.deepEqual(result.notes, [
    '共享额度查询失败（HTTP 403）',
    '按模型显示（多个模型可能共用额度）',
  ]);
  assert.equal(result.balance, 'AI credits 余额\nGOOGLE_ONE_AI  125.5');
});

test('complete failures return an unsuccessful JSON result with all query diagnostics', async (t) => {
  mockRpc(t, 401, 503);
  const result = await queryUsage(auth, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.notes, ['共享额度查询失败（HTTP 401）', '模型额度查询失败']);
  assert.equal(result.balance, 'AI credits 余额查询失败（HTTP 503）');
  assert.equal(result.plan, null);
});

test('the real auth session exposes only the stored email as email, independent of accountId fallback', async () => {
  const create = (email?: string) =>
    createAuth({
      readRecord: async () => ({
        kind: 'grant',
        payload: {
          access: 'private-token',
          refresh: 'refresh',
          expires: Date.now() + 60_000,
          projectId: 'private-project',
          ...(email === undefined ? {} : { email }),
        },
      }),
      modifyRecord: async () => assert.fail('unexpected refresh'),
    });
  assert.equal((await create('person@example.test').getSession()).email, 'person@example.test');
  const missing = await create().getSession();
  assert.equal(missing.email, null);
  assert.equal(missing.accountId, 'private-project');
});

test('a cancelled quota query stops before credentials or HTTP requests are read', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    queryUsage(
      { ...auth, getSession: async () => assert.fail('cancelled session read') },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
});
