import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const packageVersion = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

const scenario = process.argv[2] ?? 'modern';
const sessionId = 'fixture-session';
let authenticated = false;
let safeMode = false;
let promptId;
let turn = 0;
const replies = new Map();
function send(value) {
  const buffer = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\r\n');
  for (let offset = 0; offset < buffer.length; offset += 7)
    process.stdout.write(buffer.subarray(offset, offset + 7));
}
function result(id, value) {
  send({ id, result: value });
}
function update(value, id = sessionId) {
  send({ method: 'session/update', params: { sessionId: id, update: value } });
}
function request(id, method, params) {
  return new Promise((resolve) => {
    replies.set(id, resolve);
    send({ id, method, params });
  });
}
function configOptions() {
  const options = [
    {
      id: 'model-option',
      category: 'model',
      type: 'select',
      currentValue: 'gemini-one',
      options: [
        {
          group: 'Gemini',
          options: [
            { value: 'gemini-one', name: 'Gemini One' },
            { value: 'gemini-two', name: 'Gemini Two' },
          ],
        },
      ],
    },
    {
      id: 'mode-option',
      category: 'mode',
      type: 'select',
      currentValue: 'auto_edit',
      options: [
        { value: 'auto_edit', name: 'Auto edit' },
        { value: 'default', name: 'Default' },
      ],
    },
  ];
  if (scenario === 'dangerous-empty') options[1].options = [];
  if (scenario === 'unreported-mode') return options.slice(0, 1);
  return options;
}

async function handle(message) {
  if (!message.method) {
    replies.get(message.id)?.(message);
    replies.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize') {
    assert.equal(params.protocolVersion, 2);
    assert.deepEqual(params.clientCapabilities, {});
    assert.equal(typeof params.clientInfo.name, 'string');
    assert.equal(params.clientInfo.version, packageVersion);
    if (scenario === 'hang-init') return;
    send({ method: 'session/update', params: { update: { sessionUpdate: 'test-pre-session' } } });
    result(id, {
      protocolVersion: scenario === 'legacy' ? 2 : 1,
      authMethods: [{ id: 'oauth-personal', name: 'Personal' }],
      agentCapabilities: {},
    });
    return;
  }
  if (method === 'authenticate') {
    assert.equal(params.methodId, 'gemini-api-key');
    assert.equal(process.env.GEMINI_API_KEY, 'fixture-key');
    if (scenario === 'auth-error') {
      send({ id, error: { code: -32000, message: 'fixture-key is secret' } });
      return;
    }
    authenticated = true;
    result(id, {});
    return;
  }
  if (method === 'session/new') {
    assert(authenticated);
    assert.equal(params.cwd, process.cwd());
    assert.deepEqual(params.mcpServers, []);
    if (scenario === 'unreported-mode') safeMode = true; // This fixture starts with approval-required defaults.
    result(
      id,
      scenario.startsWith('legacy')
        ? {
            sessionId,
            models: {
              currentModelId: 'gemini-one',
              availableModels: [
                { modelId: 'gemini-one', name: 'Gemini One' },
                { modelId: 'gemini-two', name: 'Gemini Two' },
              ],
            },
            modes: {
              currentModeId: 'yolo',
              availableModes:
                scenario === 'legacy-dangerous-empty'
                  ? []
                  : [
                      { id: 'yolo', name: 'YOLO' },
                      { id: 'default', name: 'Default' },
                    ],
            },
          }
        : { sessionId, configOptions: configOptions() },
    );
    return;
  }
  if (method === 'session/set_config_option') {
    assert.equal(params.sessionId, sessionId);
    if (params.configId === 'mode-option') {
      assert.equal(params.value, 'default');
      safeMode = true;
    } else {
      assert.equal(params.configId, 'model-option');
      assert.equal(params.value, 'gemini-two');
      update({ sessionUpdate: 'test-model', value: params.value, method });
    }
    result(id, {});
    return;
  }
  if (method === 'session/set_mode') {
    assert.equal(params.modeId, 'default');
    safeMode = true;
    result(id, {});
    return;
  }
  if (method === 'session/set_model') {
    assert.equal(params.modelId, 'gemini-two');
    update({ sessionUpdate: 'test-model', value: params.modelId, method });
    result(id, {});
    return;
  }
  if (method === 'session/cancel') {
    assert.equal(params.sessionId, sessionId);
    assert.equal(id, undefined);
    if (scenario === 'ignore-cancel') {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'late after cancellation' },
      });
      return;
    }
    if (promptId !== undefined) {
      result(promptId, { stopReason: 'cancelled' });
      promptId = undefined;
    }
    return;
  }
  if (method === 'session/prompt') {
    assert(safeMode);
    assert.equal(params.sessionId, sessionId);
    assert.deepEqual(params.prompt, [{ type: 'text', text: 'hello' }]);
    promptId = id;
    turn++;
    if (scenario === 'exit') {
      process.exit(7);
    }
    if (scenario === 'malformed') {
      process.stdout.write('not-json fixture-key\n');
      return;
    }
    if (scenario === 'ignore-cancel') {
      update({ sessionUpdate: 'test-started' });
      return;
    }
    update(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign' } },
      'another-session',
    );
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } });
    if (scenario === 'requests') {
      for (const name of ['fs/read_text_file', 'terminal/create']) {
        const answer = await request(name, name, { sessionId, path: '/secret' });
        update({ sessionUpdate: 'test-rejection', method: name, code: answer.error?.code });
      }
      const answer = await request('foreign-permission', 'session/request_permission', {
        sessionId: 'another-session',
        options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
      });
      update({
        sessionUpdate: 'test-rejection',
        method: 'foreign-permission',
        code: answer.error?.code,
      });
    }
    const answer = await request(`permission-${turn}`, 'session/request_permission', {
      sessionId,
      toolCall: { toolCallId: `call-${turn}`, title: 'Read project file' },
      options: [
        { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
      ],
    });
    update({ sessionUpdate: 'test-permission', outcome: answer.result?.outcome });
    if (promptId === id) {
      result(id, { stopReason: 'end_turn' });
      promptId = undefined;
    }
    return;
  }
  throw new Error(`Unexpected client method: ${method}`);
}
createInterface({ input: process.stdin }).on('line', (line) => {
  void handle(JSON.parse(line)).catch((error) => {
    process.stderr.write(String(error));
    process.exit(9);
  });
});
