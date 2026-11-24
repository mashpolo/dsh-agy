import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { Context } from '@deepseek-ai/cordis';
import * as connection from '@deepseek-ai/dsh-client-connection';
import * as plugin from '../dist/index.js';

test('ACP actions require an owner POST and resolve a live Harness workspace', async () => {
  const ctx = new Context();
  const home = await mkdtemp(join(tmpdir(), 'dsh-acp-'));
  try {
    await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false });
    await ctx.plugin(connection);
    const fiber = ctx.plugin(plugin);
    await fiber;
    const handler = ctx.connection.createSharedFetchHandler('/api');
    const call = (peer) =>
      handler.fetch(
        new Request('http://localhost/api/antigravity/acp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'open', harnessSessionId: 'not-a-real-workspace' }),
        }),
        peer,
      );
    assert.equal((await call({ principal: { kind: 'guest' } })).status, 403);
    const response = await call(ctx.connection.browserPeer);
    assert.match((await response.json()).error, /本机项目会话/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await fiber.dispose();
    assert.equal((await call(ctx.connection.browserPeer)).status, 404);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
