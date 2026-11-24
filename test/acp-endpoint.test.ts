import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpEndpoint } from '../src/acp/endpoint.js';

test('owner HTTP endpoint carries two turns, explicit approval and cancellation in one agent', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
  const api = new AcpEndpoint(
    async (hostId) => {
      assert.equal(hostId, 'host-session');
      return process.cwd();
    },
    async (cwd) => ({
      command: process.execPath,
      cwd,
      args: [fixture],
      env: { GEMINI_API_KEY: 'fixture-key' },
      cleanup: async () => {},
    }),
  );
  const call = async (body: object) => {
    const response = await api.fetch(
      new Request('http://localhost/api/antigravity/acp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const opened = await call({ action: 'open', harnessSessionId: 'host-session' });
    assert.equal(opened.models.length, 2);
    const id = opened.id;
    let after = 0;
    const next = async (type: string) => {
      for (let i = 0; i < 100; i++) {
        const { events } = await call({ action: 'poll', id, after });
        for (const event of events) {
          after = event.seq;
          if (event.type === type) return event;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Error('Missing ' + type);
    };
    for (const cancel of [false, true]) {
      await call({ action: 'prompt', id, text: 'hello', model: 'gemini-two' });
      assert.equal((await next('text')).text, '你好');
      const permission = await next('permission');
      assert.equal(permission.title, 'Read project file');
      assert.equal(permission.options[0].id, 'allow');
      if (cancel) await call({ action: 'cancel', id });
      else
        await call({
          action: 'permission',
          id,
          permissionId: permission.permissionId,
          optionId: 'allow',
        });
      assert.equal((await next('done')).status, cancel ? 'cancelled' : 'end_turn');
    }
    await call({ action: 'close', id });
  } finally {
    api.dispose();
  }
});
