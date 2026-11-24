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
    env: { GEMINI_API_KEY: 'fixture-key' },
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

test('initializes, selects explicit API-key authentication and safe mode, then streams one scoped turn', async () => {
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

test('refuses an explicitly dangerous current mode with no safe selectable alternative', async () => {
  for (const scenario of ['dangerous-empty', 'legacy-dangerous-empty']) {
    const f = setup(scenario);
    try {
      await assert.rejects(f.process.start(), /approval|mode/i);
    } finally {
      f.process.close();
      await f.exit;
    }
  }
});

test('preserves the CLI approval-required default when it reports no mode configuration', async () => {
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

test('uses legacy availableModels and set_model without switching to an unsafe mode', async () => {
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

test('authentication failure never falls back to personal subscription or leaks server diagnostics', async () => {
  const f = setup('auth-error');
  await assert.rejects(f.process.start(), (error) => {
    assert(error instanceof Error);
    assert(!error.message.includes('fixture-key'));
    return true;
  });
  f.process.close();
  await f.exit;
  assert.equal(f.exits(), 1);
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

test('missing API key is rejected before any authentication or model call', async () => {
  const agent = new AcpProcess({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    env: {},
    onUpdate() {},
    onPermission: async () => null,
    onExit() {},
  });
  await assert.rejects(agent.start(), /GEMINI_API_KEY/);
  agent.close();
});
