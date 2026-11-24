import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { setImmediate as tick } from 'node:timers/promises';
import { AcpSession, postAcp } from '../src/acp-session-client.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const opened = {
  id: 'session-1',
  models: [{ id: 'model-1', name: 'One' }],
  currentModel: 'model-1',
  cwd: '/work',
};
test('browser plugin registers only the Antigravity session header action', async () => {
  const bundle = await build({
    entryPoints: ['src/client.jsx'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    loader: { '.css': 'text' },
    external: ['react', 'react-dom'],
  });
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, require: () => ({}) });
  const slots = [];
  module.exports.apply({
    slots: {
      inject: (_scope, register) => register(),
      register: ({ name, id }) => slots.push([name, id]),
    },
  });
  assert.deepEqual(slots, [['conversation.session.header.actions', 'antigravity-acp']]);
});

test('multi-turn ACP uses one session, serialized polling and permission responses', async () => {
  const calls = [];
  const release = deferred();
  const turns = [
    [
      { seq: 1, type: 'text', text: '正在' },
      { seq: 2, type: 'thought', text: '内部过程' },
      { seq: 3, type: 'text', text: '读取' },
      {
        seq: 4,
        type: 'permission',
        permissionId: 'p1',
        title: '读取文件',
        options: [{ id: 'yes', label: '允许' }],
      },
      { seq: 5, type: 'tool', text: '调用过程' },
    ],
    [{ seq: 6, type: 'done' }],
    [
      { seq: 7, type: 'text', text: '完成' },
      { seq: 8, type: 'done' },
    ],
  ];
  let waiting = 0;
  const session = new AcpSession(async (body) => {
    calls.push(body);
    if (body.action === 'open') return opened;
    if (body.action === 'poll') {
      assert.equal(waiting++, 0);
      if (body.after === 5) await release.promise;
      waiting--;
      return { events: turns.shift() };
    }
    return { ok: true };
  }, 0);
  await session.open('harness-session');
  assert.deepEqual(
    calls.map((c) => c.action),
    ['open'],
  );
  await Promise.all([session.send('第一轮', 'model-1'), session.send('重复', 'model-1')]);
  await tick();
  assert.equal(session.state.entries.find((x) => x.type === 'text').text, '正在读取');
  assert.deepEqual(
    session.state.entries.map((e) => e.type),
    ['user', 'text', 'permission'],
  );
  await Promise.all([session.permission('p1', 'yes'), session.permission('p1', 'yes')]);
  assert.equal(calls.filter((c) => c.action === 'permission').length, 1);
  release.resolve();
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(session.state.running, false);
  assert.deepEqual(
    calls.filter((c) => c.action === 'poll').map((c) => c.after),
    [0, 5],
  );
  await session.send('继续', 'model-1');
  await tick();
  assert.deepEqual(
    calls.filter((c) => c.action === 'prompt').map((c) => [c.id, c.text, c.model]),
    [
      ['session-1', '第一轮', 'model-1'],
      ['session-1', '继续', 'model-1'],
    ],
  );
  assert.deepEqual(
    session.state.entries.filter((x) => x.type === 'text').map((x) => x.text),
    ['正在读取', '完成'],
  );
  await session.close();
  assert.equal(calls.at(-1).action, 'close');
  assert.equal(session.state.session, null);
});

test('poll errors pause until requested, without replaying a prompt', async () => {
  const calls = [];
  const session = new AcpSession(async (body) => {
    calls.push(body.action);
    if (body.action === 'open') return opened;
    if (body.action === 'poll') {
      if (calls.filter((x) => x === 'poll').length === 1) throw new Error('连接中断');
      return { events: [{ seq: 1, type: 'done' }] };
    }
    return { ok: true };
  }, 0);
  await session.open('harness-session');
  await session.send('hello');
  await tick();
  assert.equal(session.state.pollPaused, true);
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(calls.filter((x) => x === 'poll').length, 1);
  session.resume();
  await tick();
  assert.equal(session.state.running, false);
  assert.equal(calls.filter((x) => x === 'prompt').length, 1);
  session.dispose();
});

test('unmount while opening closes the late session', async () => {
  const pending = deferred();
  const calls = [];
  const session = new AcpSession(async (body) => {
    calls.push(body);
    return body.action === 'open' ? pending.promise : { ok: true };
  });
  const opening = session.open('harness-session');
  session.dispose();
  pending.resolve(opened);
  await opening;
  assert.deepEqual(calls, [
    { action: 'open', harnessSessionId: 'harness-session' },
    { action: 'close', id: 'session-1' },
  ]);
});

test('ACP requests are same-origin JSON POSTs under the Harness mount', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'api/antigravity/acp');
    assert.equal(init.method, 'POST');
    assert.equal(init.mode, 'same-origin');
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(init.body), {
      action: 'open',
      harnessSessionId: 'harness-session',
    });
    return Response.json(opened);
  });
  assert.deepEqual(await postAcp({ action: 'open', harnessSessionId: 'harness-session' }), opened);
});

test('cancellation is issued once and prior-turn permissions cannot be answered', async () => {
  const release = deferred(),
    next = deferred(),
    calls = [];
  let n = 0;
  const session = new AcpSession(async (body) => {
    calls.push(body.action);
    if (body.action === 'open') return opened;
    if (body.action === 'poll') {
      if (++n === 1)
        return { events: [{ seq: 1, type: 'permission', permissionId: 'old', options: [] }] };
      if (n === 2) {
        await release.promise;
        return { events: [{ seq: 2, type: 'done' }] };
      }
      return next.promise;
    }
    return { ok: true };
  }, 0);
  await session.open('harness-session');
  await session.send('run');
  await tick();
  await Promise.all([session.cancel(), session.cancel()]);
  assert.equal(calls.filter((x) => x === 'cancel').length, 1);
  release.resolve();
  await new Promise((done) => setTimeout(done, 10));
  await session.send('next');
  await session.permission('old', null);
  assert.ok(!calls.includes('permission'));
  session.dispose();
  next.resolve({ events: [] });
});

test('opening without a Harness session explains how to select a workspace', async () => {
  const session = new AcpSession(async () => assert.fail('should not contact ACP'));
  assert.equal(await session.open(undefined), false);
  assert.match(session.state.error, /工作目录.*Harness 会话/);
  assert.equal(session.state.session, null);
});

test('CLI startup errors reach the panel when the executable is unavailable', async (t) => {
  const message = '找不到 agy 可执行文件。';
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: message }, { status: 503 }),
  );
  const session = new AcpSession();
  assert.equal(await session.open('harness-session'), false);
  assert.equal(session.state.error, message);
});

for (const expiredAction of ['prompt', 'poll', 'close']) {
  test(
    'HTTP 410 during ' +
      expiredAction +
      ' preserves the transcript until the user starts a new session',
    async (t) => {
      let id = 0,
        turn = 0;
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const { action } = JSON.parse(init.body);
        if (action === 'open') return Response.json({ ...opened, id: 'acp-' + ++id });
        if (action === 'prompt') ++turn;
        if (action === expiredAction && (turn > 1 || action === 'close'))
          return Response.json({ error: 'Gone' }, { status: 410 });
        if (action === 'poll')
          return Response.json({
            events: [
              { seq: 1, type: 'text', text: '第一轮的回复' },
              { seq: 2, type: 'done', status: 'cancelled' },
            ],
          });
        return Response.json({ ok: true });
      });
      const session = new AcpSession();
      await session.open('harness');
      await session.send('first');
      await tick();
      assert.equal(session.state.entries.at(-1).text, '已停止');
      if (expiredAction === 'close') await session.close();
      else await session.send('second');
      await tick();
      assert.equal(session.state.expired, true);
      assert.equal(session.state.session, null);
      assert.equal(session.state.running, false);
      assert.equal(session.state.pollPaused, false);
      assert.ok(session.state.entries.some((e) => e.text === '第一轮的回复'));
      await session.open('harness');
      assert.equal(session.state.session.id, 'acp-2');
      assert.equal(session.state.expired, false);
      assert.deepEqual(session.state.entries, []);
      session.dispose();
    },
  );
}
