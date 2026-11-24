import type { AuthorizationFlow } from '@deepseek-ai/dsh-authorization';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import {
  credentialKey,
  type CredentialProvider,
  type CredentialRecord,
} from '@deepseek-ai/dsh-credentials';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { getApiKey, loginAntigravity, OAuthError, refreshAntigravityToken } from './oauth.js';

export const CREDENTIAL_KEY = credentialKey('dsh-antigravity', 'antigravity');

type Credentials = Awaited<ReturnType<typeof loginAntigravity>>;
type CredentialStore = Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>;

export interface Auth {
  getSession(): Promise<{ apiKey: string; accountId: string; email?: string | null }>;
  getApiKey(): Promise<string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]+$/.test(value);
}

/** The credential store deliberately treats grant payloads as opaque JSON. */
function readCredentials(record: CredentialRecord | undefined): Credentials {
  const value = record?.kind === 'grant' ? record.payload : undefined;
  if (
    !isObject(value) ||
    !isToken(value.access) ||
    !isToken(value.refresh) ||
    typeof value.expires !== 'number' ||
    !Number.isFinite(value.expires) ||
    value.expires < 0 ||
    (value.projectId !== undefined && !isToken(value.projectId)) ||
    (value.email !== undefined && typeof value.email !== 'string') ||
    (value.oauthClientId !== undefined && !isToken(value.oauthClientId))
  ) {
    throw new LlmError(
      'Sign in to Antigravity by running dsh-antigravity-login with the same DSH_HOME as DeepSeek Harness.',
      'MISSING_CREDENTIAL',
    );
  }
  return {
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    ...(value.email === undefined ? {} : { email: value.email }),
    ...(value.oauthClientId === undefined ? {} : { oauthClientId: value.oauthClientId }),
  };
}

function grant(credentials: Credentials): CredentialRecord {
  // OAuth may return optional properties set to undefined; the store accepts JSON only.
  return { kind: 'grant', payload: readCredentials({ kind: 'grant', payload: credentials }) };
}

/** Read per operation, and let the host serialize refreshes across callers/processes. */
export function createAuth(
  store: CredentialStore,
  refresh: typeof refreshAntigravityToken = refreshAntigravityToken,
): Auth {
  async function getSession() {
    let credentials = readCredentials(await store.readRecord(CREDENTIAL_KEY));
    if (credentials.expires <= Date.now()) {
      const updated = await store.modifyRecord(CREDENTIAL_KEY, async (record) => {
        const current = readCredentials(record);
        if (current.expires > Date.now()) return undefined;
        try {
          return grant(await refresh(current));
        } catch (error) {
          throw new LlmError(
            error instanceof OAuthError
              ? error.message
              : 'Antigravity token refresh failed. Check your connection or sign in again with dsh-antigravity-login.',
            'AUTH',
          );
        }
      });
      credentials = readCredentials(updated);
    }
    return {
      apiKey: getApiKey(credentials),
      accountId: credentials.email || credentials.projectId || 'antigravity-default',
      email: credentials.email?.trim() || null,
    };
  }
  return {
    getSession,
    getApiKey: async () => (await getSession()).apiKey,
  };
}

/** Native Harness authorization uses the host credential store. */
export function createLoginFlow(
  login: typeof loginAntigravity = loginAntigravity,
): AuthorizationFlow {
  return {
    key: CREDENTIAL_KEY,
    label: 'Antigravity',
    methods: [{ id: 'oauth', label: 'Sign in with Google' }],
    async run(session) {
      const pendingPrompt = new AbortController();
      const signal = AbortSignal.any([session.signal, pendingPrompt.signal]);
      let credentials: Credentials;
      try {
        credentials = await login({
          signal: session.signal,
          onAuth: ({ url, instructions }) =>
            session.notify({
              url,
              message: instructions ?? 'Open Google to sign in to Antigravity.',
            }),
          onPrompt: ({ message, placeholder, signal: promptSignal }) =>
            session.prompt({
              kind: 'secret',
              message,
              signal: promptSignal ? AbortSignal.any([signal, promptSignal]) : signal,
              ...(placeholder === undefined ? {} : { placeholder }),
            }),
          onProgress: (message) => session.notify({ message }),
        });
      } finally {
        // A browser callback can win while the manual-paste prompt is still open.
        pendingPrompt.abort();
      }
      await session.commit(grant(credentials));
    },
  };
}

/**
 * Standalone login shares the official DSH store. Launch it with the same
 * DSH_HOME and user account as Harness.
 */
export async function runLogin(
  args = process.argv.slice(2),
  login: typeof loginAntigravity = loginAntigravity,
): Promise<void> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(
      'Usage: dsh-antigravity-login\n\nSign in to Antigravity with Google.\nSet ANTIGRAVITY_CLIENT_ID to your registered Google Desktop OAuth client; set ANTIGRAVITY_CLIENT_SECRET only if that client requires it.\nExisting grants must be refreshed with the same OAuth client that authorized them.\nANTIGRAVITY_PROJECT_ID can select an existing project when discovery is unavailable.\nRun with the same DSH_HOME as DeepSeek Harness. Credentials are saved through its official credential store.',
    );
    return;
  }
  if (args.length > 0) {
    console.error('Usage: dsh-antigravity-login [--help]');
    process.exitCode = 2;
    return;
  }

  const [{ Context }, { default: AuthorizationService }, { default: LocalCredentialProvider }] =
    await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-authorization'),
      import('@deepseek-ai/dsh-credentials-local'),
    ]);
  const ctx = new Context();
  const controller = new AbortController();
  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!hidden) process.stderr.write(chunk, encoding);
      done();
    },
  });
  const terminal = createInterface({
    input: process.stdin,
    output,
    terminal: process.stdin.isTTY ?? false,
  });
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  terminal.on('SIGINT', cancel);
  terminal.on('close', cancel);

  try {
    await ctx.plugin(LocalCredentialProvider, { watch: false });
    await ctx.plugin(AuthorizationService);
    ctx.authorization.registerFlow(createLoginFlow(login));
    const outcome = await ctx.authorization.begin({
      key: CREDENTIAL_KEY,
      signal: controller.signal,
      interaction: {
        notify({ message, url, code }) {
          console.error(message);
          if (url) console.error(url);
          if (code) console.error(code);
        },
        async prompt(prompt) {
          console.error(prompt.message);
          if (prompt.kind === 'select') {
            for (const option of prompt.options) console.error(`${option.id}: ${option.label}`);
          }
          hidden = prompt.kind === 'secret';
          try {
            return await terminal.question('', { signal: prompt.signal });
          } finally {
            hidden = false;
            process.stderr.write('\n');
          }
        },
      },
    });
    if (outcome.status === 'authorized') {
      console.error('Antigravity sign-in complete. Refresh the model list in DeepSeek Harness.');
    } else {
      console.error('Antigravity sign-in cancelled.');
      process.exitCode = 130;
    }
  } catch (error) {
    // OAuth callbacks and token responses must never enter terminal diagnostics.
    console.error(
      controller.signal.aborted
        ? 'Antigravity sign-in cancelled.'
        : error instanceof OAuthError
          ? error.message
          : 'Antigravity sign-in failed. Check your connection and run dsh-antigravity-login again.',
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    terminal.close();
    output.end();
    await ctx.fiber.dispose();
  }
}
