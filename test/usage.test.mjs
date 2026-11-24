import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as plugin from '../dist/index.js';

test('Harness quota command preserves partial results, zeroes and missing fields', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-usage-'));
  const ctx = new Context();
  try {
    await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false });
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(CommandRuntime);
    await ctx.plugin(plugin);
    const command = ctx.commands.find({}, 'antigravity-usage');
    assert.ok(command, 'native slash command registered');
    const run = () => command.handler({ rawInput: '', signal: new AbortController().signal });
    await ctx.credentials.modifyRecord('dsh-antigravity/antigravity', () => ({
      kind: 'grant',
      payload: {
        access: 'test',
        refresh: 'test',
        expires: Date.now() + 3600000,
        projectId: 'test',
      },
    }));
    let summary = {
      groups: [
        {
          displayName: 'Weekly',
          buckets: [
            {
              bucketId: 'a',
              displayName: 'Gemini',
              remainingFraction: 0,
              resetTime: '2026-11-30T02:00:00Z',
            },
            { bucketId: 'b', displayName: 'Claude' },
          ],
        },
      ],
    };
    let assist = {
      paidTier: { availableCredits: [{ creditType: 'PAID', creditAmount: '0' }] },
      currentTier: { availableCredits: [{ creditType: 'OTHER', creditAmount: 100 }] },
    };
    let catalog;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test');
      const method = String(url).split(':').pop();
      const bodies = {
        retrieveUserQuotaSummary: summary,
        loadCodeAssist: assist,
        fetchAvailableModels: catalog,
      };
      assert.ok(Object.hasOwn(bodies, method), method);
      return bodies[method] ? Response.json(bodies[method]) : new Response(null, { status: 403 });
    });
    const grouped = await run();
    assert.equal(grouped.kind, 'success');
    assert.match(grouped.text, /Gemini.*剩余 0%.*2026/);
    assert.match(grouped.text, /Claude.*剩余未返回/);
    assert.match(grouped.text, /PAID.*\b0\b/);
    assert.doesNotMatch(grouped.text, /OTHER/);
    summary = undefined;
    catalog = {
      models: { model: { displayName: 'Flash', quotaInfo: { remainingFraction: 0.75 } } },
    };
    assist = { available_credits: [{ credit_amount: '  ' }] };
    const fallback = await run();
    assert.match(fallback.text, /Flash.*剩余 75%.*重置时间未返回/);
    assert.match(fallback.text, /AI credits 余额.*未返回/);
    assist = { available_credits: [{ credit_type: 'GOOGLE_ONE_AI', credit_amount: '125.5' }] };
    assert.match((await run()).text, /GOOGLE_ONE_AI.*125\.5/);
    assist = catalog = undefined;
    assert.equal((await run()).kind, 'error');
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
