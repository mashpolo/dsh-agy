import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { prepareLaunch } from '../src/acp/launch.js';

function environment(t: TestContext, values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function profileRoot(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'acp-launch-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('missing API key gives safe Chinese guidance without creating a profile', async (t) => {
  const root = await profileRoot(t);
  environment(t, { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: 'other-private-key' });
  await assert.rejects(
    prepareLaunch({ command: 'agy', cwd: '/project', profileRoot: root }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /GEMINI_API_KEY/);
      assert.match(error.message, /请/);
      assert.doesNotMatch(error.message, /other-private-key/);
      return true;
    },
  );
  assert.deepEqual(await fs.readdir(root), []);
});

test('launch uses only the API key and an isolated agy profile without changing parent environment', async (t) => {
  const root = await profileRoot(t);
  const excluded = [
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_CLOUD_QUOTA_PROJECT',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_OAUTH_ACCESS_TOKEN',
    'GCLOUD_PROJECT',
    'CLOUDSDK_CORE_PROJECT',
    'AGY_ACP_CCPA_PROJECT',
    'AGY_ACP_ENABLE_OAUTH',
    'ANTIGRAVITY_CLIENT_ID',
    'ANTIGRAVITY_CLIENT_SECRET',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'NODE_AUTH_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'BROWSER',
    'ELECTRON_RUN_AS_NODE',
    'CHROME_CRASHPAD_PIPE_NAME',
  ];
  environment(t, {
    ...Object.fromEntries(excluded.map((name) => [name, 'other-private-auth'])),
    GEMINI_API_KEY: '  dedicated-api-key  ',
    GEMINI_HOME: '/personal/gemini',
    AGY_ACP_FORCE_FILE_STORAGE: '0',
    AGY_CLI_DISABLE_AUTO_UPDATE: '0',
    ACP_LAUNCH_TEST_VALUE: 'preserved',
    SSH_CONNECTION: undefined,
  });
  const launch = await prepareLaunch({
    command: '/tools/agy cli',
    cwd: '/project',
    profileRoot: root,
  });
  t.after(launch.cleanup);
  assert.equal(launch.command, '/tools/agy cli');
  assert.equal(launch.cwd, '/project');
  assert.equal(launch.args[0], 'acp');
  const geminiDir = launch.args[2]!;
  assert.deepEqual(launch.args, [
    'acp',
    '--gemini-dir',
    geminiDir,
    '--app-data-dir',
    'antigravity-acp',
    '--sandbox',
  ]);
  assert.ok(geminiDir.startsWith(root + '/'));
  const settings = await fs.readFile(join(geminiDir, 'antigravity-acp', 'settings.json'), 'utf8');
  assert.deepEqual(JSON.parse(settings), { auth: { type: 'gemini-api-key' } });
  assert.doesNotMatch(settings, /dedicated-api-key|other-private-auth/);
  assert.equal(launch.env.GEMINI_API_KEY, 'dedicated-api-key');
  assert.equal(launch.env.GEMINI_HOME, geminiDir);
  for (const name of excluded) assert.equal(launch.env[name], undefined, name);
  assert.equal(launch.env.ACP_LAUNCH_TEST_VALUE, 'preserved');
  assert.equal(launch.env.AGY_ACP_FORCE_FILE_STORAGE, '1');
  assert.equal(launch.env.AGY_CLI_DISABLE_AUTO_UPDATE, '1');
  assert.equal(launch.env.SSH_CONNECTION, undefined);
  assert.equal(process.env.GEMINI_HOME, '/personal/gemini');
  assert.equal(process.env.GEMINI_API_KEY, '  dedicated-api-key  ');
});

test('concurrent launches have separate profiles and cleanup is safe to repeat', async (t) => {
  const root = await profileRoot(t);
  environment(t, { GEMINI_API_KEY: 'dedicated-api-key' });
  const [first, second] = await Promise.all([
    prepareLaunch({ command: 'agy', cwd: '/first', profileRoot: root }),
    prepareLaunch({ command: 'agy', cwd: '/second', profileRoot: root }),
  ]);
  t.after(first.cleanup);
  t.after(second.cleanup);
  assert.notEqual(first.args[2], second.args[2]);
  await first.cleanup();
  await first.cleanup();
  await assert.rejects(fs.stat(first.args[2]!), { code: 'ENOENT' });
  await fs.access(join(second.args[2]!, 'antigravity-acp', 'settings.json'));
  await second.cleanup();
  assert.deepEqual(await fs.readdir(root), []);
});

test('profile write failure removes only the unfinished launch directory', async (t) => {
  const root = await profileRoot(t);
  environment(t, { GEMINI_API_KEY: 'dedicated-api-key' });
  await fs.writeFile(join(root, 'keep.txt'), 'existing file');
  t.mock.method(fs, 'writeFile', async () => {
    throw new Error('simulated disk failure');
  });
  await assert.rejects(
    prepareLaunch({ command: 'agy', cwd: '/project', profileRoot: root }),
    /disk failure/,
  );
  assert.deepEqual(await fs.readdir(root), ['keep.txt']);
});
