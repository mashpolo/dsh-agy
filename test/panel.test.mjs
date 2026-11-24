import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as connection from '@deepseek-ai/dsh-client-connection';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as plugin from '../dist/index.js';

test('account panel uses an owner-only, uncached route and reports a missing login', async () => {
  const ctx = new Context();
  const home = await mkdtemp(join(tmpdir(), 'dsh-panel-'));
  try {
    await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false });
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(connection);
    const fiber = ctx.plugin(plugin);
    await fiber;
    const handler = ctx.connection.createSharedFetchHandler('/api');
    const get = (peer) =>
      handler.fetch(new Request('http://localhost/api/antigravity/usage'), peer);
    const response = await get(ctx.connection.browserPeer);
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /登录/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await get({ principal: { kind: 'guest' } })).status, 403);
    await fiber.dispose();
    assert.equal((await get(ctx.connection.browserPeer)).status, 404);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
