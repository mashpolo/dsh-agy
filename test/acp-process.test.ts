import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpProcess } from '../src/acp/process.js';

const fixture = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
function setup(
  scenario = 'modern',
  onPermission: (request: Record<string, unknown>) => Promise<string | null> = async () => 'allow',
  onUpdate: (update: Record<string, unknown>) => void = () => {},
) {
  const updates: Record<string, unknown>[] = [];
  let exits = 0;
  let exited!: () => void;
  const exit = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const process = new AcpProcess({
    command: globalThis.process.execPath,
    args: [fixture, scenario],
    cwd: globalThis.process.cwd(),
    env: {},
    onUpdate: (update) => {
      updates.push(update);
      onUpdate(update);
    },
    onPermission,
    onExit: () => {
      exits++;
      exited();
    },
  });
  return { process, updates, exit, exits: () => exits };
}

test('initializes a CLI-owned session without authentication or mode changes, then streams one scoped turn', async () => {
  const f = setup();
  try {
    assert.deepEqual(await f.process.start(), {
      models: [
        { id: 'gemini-one', name: 'Gemini One' },
        { id: 'gemini-two', name: 'Gemini Two' },
      ],
      currentModel: 'gemini-one',
    });
    await f.process.setModel('gemini-two');
    await assert.rejects(f.process.setModel('not-advertised'), /model/i);
    assert.equal(await f.process.prompt('hello'), 'end_turn');
    assert(
      f.updates.some(
        (update) =>
          update.sessionUpdate === 'agent_message_chunk' && JSON.stringify(update).includes('你好'),
      ),
    );
    assert(!JSON.stringify(f.updates).includes('foreign'));
    assert(!f.updates.some((update) => update.sessionUpdate === 'test-pre-session'));
    assert(
      f.updates.some(
        (update) =>
          JSON.stringify(update.outcome) ===
          JSON.stringify({ outcome: 'selected', optionId: 'allow' }),
      ),
    );
  } finally {
    f.process.close();
    await f.exit;
  }
  assert.equal(f.exits(), 1);
  await assert.rejects(f.process.start(), /closed/i);
});

test('does not dispatch a prompt while a model switch is pending', async () => {
  const f = setup();
  try {
    await f.process.start();
    const changing = f.process.setModel('gemini-two');
    await assert.rejects(f.process.prompt('hello'), /active|progress|busy/i);
    await changing;
  } finally {
    f.process.close();
    await f.exit;
  }
});

test('selecting the current model does not send a redundant model-switch request', async () => {
  const f = setup();
  try {
    await f.process.start();
    await f.process.setModel('gemini-one');
    assert.equal(f.updates.filter((update) => update.sessionUpdate === 'test-model').length, 0);
    assert.equal(await f.process.prompt('hello'), 'end_turn');
  } finally {
    f.process.close();
    await f.exit;
  }
});

test('preserves native CLI modes even when no alternative is offered', async () => {
  for (const scenario of ['native-mode-empty', 'legacy-native-mode-empty']) {
    const f = setup(scenario);
    try {
      await f.process.start();
      assert.equal(await f.process.prompt('hello'), 'end_turn');
    } finally {
      f.process.close();
      await f.exit;
    }
  }
});

test('forwards native permission requests when the CLI reports no mode configuration', async () => {
  let permissions = 0;
  const f = setup('unreported-mode', async () => {
    permissions++;
    return 'deny';
  });
  try {
    await f.process.start();
    assert.equal(await f.process.prompt('hello'), 'end_turn');
    assert.equal(permissions, 1);
    assert(
      f.updates.some(
        (update) =>
          JSON.stringify(update.outcome) ===
          JSON.stringify({ outcome: 'selected', optionId: 'deny' }),
      ),
    );
  } finally {
    f.process.close();
    await f.exit;
  }
});

test(
  'closes an agent that ignores cancellation and suppresses its late content',
  { timeout: 5000 },
  async () => {
    let notify!: () => void;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const f = setup(
      'ignore-cancel',
      async () => null,
      (update) => {
        if (update.sessionUpdate === 'test-started') notify();
      },
    );
    try {
      await f.process.start();
      const pending = f.process.prompt('hello');
      await started;
      f.process.cancel();
      await assert.rejects(pending, /cancel|closed/i);
      await f.exit;
      assert(!JSON.stringify(f.updates).includes('late after cancellation'));
      assert.equal(f.exits(), 1);
    } finally {
      f.process.close();
    }
  },
);

test('uses legacy availableModels and set_model without changing the CLI mode', async () => {
  const f = setup('legacy');
  try {
    await f.process.start();
    await f.process.setModel('gemini-two');
    assert.equal(await f.process.prompt('hello'), 'end_turn');
    assert(f.updates.some((update) => update.method === 'session/set_model'));
  } finally {
    f.process.close();
    await f.exit;
  }
});

test('never invents a permission selection or exposes unsupported client capabilities', async () => {
  let permissions = 0;
  const f = setup('requests', async () => {
    permissions++;
    return 'not-an-option';
  });
  try {
    await f.process.start();
    await f.process.prompt('hello');
    assert.equal(permissions, 1);
    assert.deepEqual(
      f.updates
        .filter((update) => update.sessionUpdate === 'test-rejection')
        .map((update) => update.code),
      [-32601, -32601, -32602],
    );
    assert(
      f.updates.some(
        (update) => JSON.stringify(update.outcome) === JSON.stringify({ outcome: 'cancelled' }),
      ),
    );
  } finally {
    f.process.close();
    await f.exit;
  }
});

test('cancels a pending permission and does not let its late answer authorize the next turn', async () => {
  let release!: (choice: string) => void, permissionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    permissionStarted = resolve;
  });
  let permissions = 0;
  const f = setup('modern', async () => {
    permissions++;
    if (permissions > 1) return 'deny';
    permissionStarted();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  try {
    await f.process.start();
    const pending = f.process.prompt('hello');
    await started;
    await assert.rejects(f.process.prompt('hello'), /active|progress|busy/i);
    await assert.rejects(f.process.setModel('gemini-two'), /active|progress|busy/i);
    f.process.cancel();
    assert.equal(await pending, 'cancelled');
    release('allow');
    assert.equal(await f.process.prompt('hello'), 'end_turn');
    assert(!f.updates.some((update) => (JSON.stringify(update.outcome) ?? '').includes('"allow"')));
  } finally {
    f.process.close();
    await f.exit;
  }
});

test('process exit and malformed NDJSON reject pending calls with safe errors and notify once', async () => {
  for (const scenario of ['exit', 'malformed']) {
    const f = setup(scenario);
    await f.process.start();
    await assert.rejects(f.process.prompt('hello'), (error) => {
      assert(error instanceof Error);
      assert(!error.message.includes('fixture-key'));
      return true;
    });
    f.process.close();
    await f.exit;
    assert.equal(f.exits(), 1);
  }
});

test('session/new auth-required errors ask for local CLI login without selecting a method', async () => {
  const f = setup('auth-required');
  await assert.rejects(f.process.start(), (error) => {
    assert(error instanceof Error);
    assert.match(error.message, /本机 CLI/);
    assert.match(error.message, /当前登录方式/);
    assert.match(error.message, /重新打开会话/);
    assert.doesNotMatch(error.message, /fixture-secret|api.?key|oauth|methodId/i);
    return true;
  });
  f.process.close();
  await f.exit;
  assert.equal(f.exits(), 1);
});

test('other session errors do not become missing-login errors or expose CLI diagnostics', async () => {
  for (const [scenario, code] of [
    ['forbidden', 403],
    ['auth-denied', -32001],
    ['internal-auth-text', -32603],
  ] as const) {
    const f = setup(scenario);
    await assert.rejects(f.process.start(), (error) => {
      assert(error instanceof Error);
      assert.match(error.message, new RegExp(String(code)));
      assert.doesNotMatch(error.message, /fixture-secret|登录|login|api.?key|oauth/i);
      return true;
    });
    f.process.close();
    await f.exit;
    assert.equal(f.exits(), 1);
  }
});

test('auth-required codes outside session creation retain their request error', async () => {
  const f = setup('prompt-auth-required');
  try {
    await f.process.start();
    await assert.rejects(f.process.prompt('hello'), (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /-32000/);
      assert.doesNotMatch(error.message, /fixture-secret|登录|login/i);
      return true;
    });
  } finally {
    f.process.close();
    await f.exit;
  }
});

test('close rejects initialization and is idempotent', async () => {
  const f = setup('hang-init');
  const pending = f.process.start();
  f.process.close();
  f.process.close();
  await assert.rejects(pending);
  await f.exit;
  assert.equal(f.exits(), 1);
});

test('omitting env preserves native child-process environment inheritance', async () => {
  const previous = process.env.ACP_PROCESS_TEST_INHERITED;
  process.env.ACP_PROCESS_TEST_INHERITED = 'fixture inherited environment';
  let exited!: () => void;
  const exit = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const agent = new AcpProcess({
    command: process.execPath,
    args: [fixture, 'inherited-env'],
    cwd: process.cwd(),
    onUpdate() {},
    onPermission: async () => null,
    onExit: exited,
  });
  try {
    await agent.start();
    assert.equal(await agent.prompt('hello'), 'end_turn');
  } finally {
    agent.close();
    await exit;
    if (previous === undefined) delete process.env.ACP_PROCESS_TEST_INHERITED;
    else process.env.ACP_PROCESS_TEST_INHERITED = previous;
  }
});
