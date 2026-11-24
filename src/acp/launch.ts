import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface LaunchOptions {
  command: string;
  cwd: string;
  profileRoot?: string;
}

export interface PreparedLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

const APP_DATA_DIR = 'antigravity-acp';
const inheritedRuntimeOverrides = new Set([
  'BROWSER',
  'PYTHONUNBUFFERED',
  'ELECTRON_RUN_AS_NODE',
  'CHROME_CRASHPAD_PIPE_NAME',
]);

function isolatedEnvironment(
  apiKey: string,
  geminiDir: string,
  temporaryDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const key = name.toUpperCase();
    if (
      /^(?:GOOGLE|GEMINI|GCLOUD|CLOUDSDK|ANTIGRAVITY|AGY)_/.test(key) ||
      /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH|AUTHORIZATION|COOKIE)(?:_|$)/.test(
        key,
      ) ||
      inheritedRuntimeOverrides.has(key)
    )
      continue;
    env[name] = value;
  }
  return {
    ...env,
    GEMINI_API_KEY: apiKey,
    GEMINI_HOME: geminiDir,
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    PYTHONUNBUFFERED: '1',
    ...(process.platform === 'win32'
      ? { TEMP: temporaryDir, TMP: temporaryDir }
      : { TMPDIR: temporaryDir }),
  };
}

/** Each process receives its own profile; the caller cleans it after the child exits. */
export async function prepareLaunch(options: LaunchOptions): Promise<PreparedLaunch> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey)
    throw new Error('请设置 GEMINI_API_KEY，使用 Google AI Studio API 密钥启动 Antigravity ACP。');

  const parent = resolve(options.profileRoot ?? tmpdir());
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, 'dsh-agy-acp-'));
  const cleanup = () => fs.rm(root, { recursive: true, force: true });
  try {
    const geminiDir = join(root, 'gemini');
    const profileDir = join(geminiDir, APP_DATA_DIR);
    const temporaryDir = join(root, 'tmp');
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(temporaryDir, { mode: 0o700 });
    await fs.writeFile(
      join(profileDir, 'settings.json'),
      JSON.stringify({ auth: { type: 'gemini-api-key' } }) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    );
    return {
      command: options.command,
      args: ['acp', '--gemini-dir', geminiDir, '--app-data-dir', APP_DATA_DIR, '--sandbox'],
      cwd: options.cwd,
      env: isolatedEnvironment(apiKey, geminiDir, temporaryDir),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
