import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { isRecord, postRpc } from './client.js';

export interface Credentials {
  access: string;
  refresh: string;
  expires: number;
  projectId?: string;
  email?: string;
  /** Older grants omit this; their refresh token still belongs to the original OAuth client. */
  oauthClientId?: string;
}

export interface OAuthCallbacks {
  signal?: AbortSignal;
  onAuth(info: { url: string; instructions?: string }): void;
  onPrompt(prompt: {
    message: string;
    placeholder?: string;
    signal?: AbortSignal;
  }): Promise<string>;
  onProgress?(message: string): void;
}

/** Only errors constructed here are safe to display without provider response bodies. */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code = 'OAUTH',
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
];

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]+$/.test(value);
}

function clientConfig(refresh = false): { id: string; secret?: string } {
  const id = process.env.ANTIGRAVITY_CLIENT_ID?.trim();
  if (!id || !nonempty(id)) {
    throw new OAuthError(
      'Set ANTIGRAVITY_CLIENT_ID to your Google Desktop OAuth client ID. ' +
        (refresh
          ? 'An existing refresh token requires the same OAuth client that originally authorized it. '
          : '') +
        'Set ANTIGRAVITY_CLIENT_SECRET only if your registered client requires a secret, then run dsh-antigravity-login.',
      'OAUTH_CONFIG',
    );
  }
  const secret = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim();
  return { id, ...(secret ? { secret } : {}) };
}

function configuredProject(): string | undefined {
  const project = process.env.ANTIGRAVITY_PROJECT_ID?.trim();
  if (project && !nonempty(project))
    throw new OAuthError(
      'ANTIGRAVITY_PROJECT_ID must contain a valid project identifier.',
      'PROJECT',
    );
  return project || undefined;
}

export function getApiKey(credentials: Credentials): string {
  const projectId = configuredProject() || credentials.projectId;
  if (!projectId)
    throw new OAuthError(
      'No Cloud Code Assist project is stored. Set ANTIGRAVITY_PROJECT_ID to an authorized project and run dsh-antigravity-login.',
      'PROJECT',
    );
  return JSON.stringify({ token: credentials.access, projectId });
}

function callbackCode(raw: string, redirect: string, state: string): string {
  let url: URL;
  try {
    url =
      raw.startsWith('?') || /^(?:state|code|error)=/.test(raw)
        ? new URL(redirect + '?' + raw.replace(/^\?/, ''))
        : new URL(raw);
  } catch {
    throw new OAuthError('Paste the full callback URL from this sign-in attempt.', 'CALLBACK');
  }
  const target = new URL(redirect);
  if (
    url.origin !== target.origin ||
    url.pathname !== target.pathname ||
    url.username ||
    url.password
  ) {
    throw new OAuthError('That callback URL does not belong to this sign-in attempt.', 'CALLBACK');
  }
  if (url.searchParams.get('state') !== state) {
    throw new OAuthError(
      'The callback state does not match this sign-in attempt. Paste the current callback URL.',
      'CALLBACK',
    );
  }
  if (url.searchParams.has('error'))
    throw new OAuthError(
      'Google declined or rejected authorization. Check the OAuth client and requested access, then run dsh-antigravity-login again.',
      'DENIED',
    );
  const code = url.searchParams.get('code');
  if (!code)
    throw new OAuthError('The callback URL is missing its authorization code.', 'CALLBACK');
  return code;
}

async function listenForCallback(state: string) {
  const pending = Promise.withResolvers<string>();
  pending.promise.catch(() => {});
  let redirect = '';
  const server = createServer((request, response) => {
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    };
    if (request.method !== 'GET') {
      response.writeHead(405, headers).end('Method not allowed.');
      return;
    }
    let code: string;
    try {
      code = callbackCode(new URL(request.url ?? '/', redirect).href, redirect, state);
    } catch (error) {
      response
        .writeHead(400, headers)
        .end('Invalid or declined OAuth callback. Return to DeepSeek Harness.');
      if (error instanceof OAuthError && error.code === 'DENIED') pending.reject(error);
      return;
    }
    response.writeHead(200, headers);
    response.end('Authorization received. Return to DeepSeek Harness to finish signing in.', () =>
      pending.resolve(code),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', () =>
      reject(
        new OAuthError(
          'Could not start a local OAuth callback listener. Check local network permissions and retry.',
          'CALLBACK_SERVER',
        ),
      ),
    );
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new OAuthError(
      'Could not determine the local OAuth callback address.',
      'CALLBACK_SERVER',
    );
  }
  redirect = `http://127.0.0.1:${address.port}/`;
  return {
    redirect,
    code: pending.promise,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function manualCode(
  callbacks: OAuthCallbacks,
  redirect: string,
  state: string,
  signal: AbortSignal,
): Promise<string> {
  let message =
    'If the browser is on another machine, paste its full callback URL here after signing in. The local browser callback is also accepted automatically.';
  while (true) {
    signal.throwIfAborted();
    const raw = await callbacks.onPrompt({
      message,
      placeholder: redirect + '?state=…&code=…',
      signal,
    });
    signal.throwIfAborted();
    try {
      return callbackCode(raw.trim(), redirect, state);
    } catch (error) {
      if (!(error instanceof OAuthError) || error.code !== 'CALLBACK') throw error;
      message = error.message;
    }
  }
}

function tokenFailure(status: number, error: unknown, refreshing: boolean): OAuthError {
  if (error === 'invalid_client' || error === 'unauthorized_client') {
    return new OAuthError(
      'Google rejected the configured OAuth client. Check ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET for your registered application.',
      'OAUTH_CONFIG',
    );
  }
  if (refreshing && error === 'invalid_grant') {
    return new OAuthError(
      'The refresh token was rejected. It must use the same OAuth client that originally authorized it. Configure that client or run dsh-antigravity-login to authorize your own client again.',
      'REFRESH',
    );
  }
  if (error === 'invalid_scope')
    return new OAuthError(
      'The configured OAuth client is not authorized for the requested scopes. Check its API access in Google Cloud Console.',
      'OAUTH_CONFIG',
    );
  return new OAuthError(
    `Google OAuth ${refreshing ? 'refresh' : 'token exchange'} failed (HTTP ${status}). Check your client configuration and run dsh-antigravity-login again.`,
    'TOKEN',
  );
}

async function requestToken(body: URLSearchParams, signal: AbortSignal, refreshing: boolean) {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new OAuthError(
      'Could not contact Google OAuth. Check your connection and retry.',
      'TRANSPORT',
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new OAuthError('Google returned an invalid OAuth response. Retry the sign-in.', 'TOKEN');
  }
  if (!response.ok)
    throw tokenFailure(response.status, isRecord(data) ? data.error : undefined, refreshing);
  if (
    !isRecord(data) ||
    !nonempty(data.access_token) ||
    typeof data.expires_in !== 'number' ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    (data.refresh_token !== undefined && !nonempty(data.refresh_token))
  ) {
    throw new OAuthError(
      'Google returned an incomplete OAuth response. Retry the sign-in.',
      'TOKEN',
    );
  }
  const lifetime = data.expires_in * 1000;
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + lifetime - Math.min(300_000, lifetime / 10),
  };
}

function projectValue(value: unknown): string | undefined {
  if (nonempty(value)) return value;
  if (isRecord(value) && nonempty(value.id)) return value.id;
  return undefined;
}

function projectFrom(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  for (const key of [
    'antigravityProjectId',
    'projectId',
    'backendProjectId',
    'userDefinedCloudaicompanionProject',
    'cloudaicompanionProject',
    'project',
  ]) {
    const project = projectValue(data[key]);
    if (project) return project;
  }
  for (const key of ['projects', 'projectIds', 'cloudaicompanionProjects']) {
    if (!Array.isArray(data[key])) continue;
    for (const value of data[key]) {
      const project = projectValue(value) || projectFrom(value);
      if (project) return project;
    }
  }
  return undefined;
}

async function discoverProject(
  token: string,
  signal: AbortSignal,
  stored?: string,
): Promise<string> {
  const explicit = configuredProject() || stored;
  if (explicit) return explicit;
  for (const method of ['loadCodeAssist', 'listCloudAICompanionProjects']) {
    try {
      const response = await postRpc(
        method,
        method === 'loadCodeAssist'
          ? {
              metadata: {
                ideType: 'ANTIGRAVITY',
                platform: 'PLATFORM_UNSPECIFIED',
                pluginType: 'GEMINI',
              },
            }
          : {},
        token,
        signal,
      );
      const project = projectFrom(await response.json());
      if (project) return project;
    } catch {
      signal.throwIfAborted();
    }
  }
  throw new OAuthError(
    'Google did not return an authorized Cloud Code Assist project. Set ANTIGRAVITY_PROJECT_ID to a project you can access, then run dsh-antigravity-login again.',
    'PROJECT',
  );
}

async function readEmail(token: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const data: unknown = await response.json();
    return isRecord(data) && typeof data.email === 'string' && data.email.trim()
      ? data.email.trim()
      : undefined;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

export async function loginAntigravity(callbacks: OAuthCallbacks): Promise<Credentials> {
  const client = clientConfig();
  callbacks.signal?.throwIfAborted();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const timeout = AbortSignal.timeout(5 * 60_000);
  const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, timeout]) : timeout;
  const prompts = new AbortController();
  const listener = await listenForCallback(state);
  const cancellation = Promise.withResolvers<never>();
  const onAbort = () => cancellation.reject(signal.reason);
  cancellation.promise.catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const query = new URLSearchParams({
      client_id: client.id,
      redirect_uri: listener.redirect,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    callbacks.onAuth({
      url: AUTHORIZE_URL + '?' + query,
      instructions:
        'Open this Google sign-in page using your configured OAuth client. Return to DeepSeek Harness after authorizing access.',
    });
    const code = await Promise.race([
      listener.code,
      manualCode(callbacks, listener.redirect, state, AbortSignal.any([signal, prompts.signal])),
      cancellation.promise,
    ]);
    prompts.abort();
    const body = new URLSearchParams({
      client_id: client.id,
      code,
      code_verifier: verifier,
      redirect_uri: listener.redirect,
      grant_type: 'authorization_code',
    });
    if (client.secret) body.set('client_secret', client.secret);
    const tokens = await requestToken(body, signal, false);
    if (!tokens.refresh)
      throw new OAuthError(
        'Google did not return a refresh token. Run dsh-antigravity-login again and allow offline access.',
        'TOKEN',
      );
    const [projectId, email] = await Promise.all([
      discoverProject(tokens.access, signal),
      readEmail(tokens.access, signal),
    ]);
    return {
      ...tokens,
      refresh: tokens.refresh,
      projectId,
      ...(email ? { email } : {}),
      oauthClientId: client.id,
    };
  } catch (error) {
    if (callbacks.signal?.aborted) throw callbacks.signal.reason;
    if (timeout.aborted)
      throw new OAuthError('Google sign-in timed out. Run dsh-antigravity-login again.', 'TIMEOUT');
    throw error;
  } finally {
    prompts.abort();
    signal.removeEventListener('abort', onAbort);
    await listener.close();
  }
}

export async function refreshAntigravityToken(
  credentials: Credentials,
  signal?: AbortSignal,
): Promise<Credentials> {
  const client = clientConfig(true);
  if (credentials.oauthClientId && credentials.oauthClientId !== client.id) {
    throw new OAuthError(
      'This refresh token requires the same OAuth client that originally authorized it. Configure that client or run dsh-antigravity-login to authorize your own client again.',
      'OAUTH_CONFIG',
    );
  }
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  requestSignal.throwIfAborted();
  const body = new URLSearchParams({
    client_id: client.id,
    refresh_token: credentials.refresh,
    grant_type: 'refresh_token',
  });
  if (client.secret) body.set('client_secret', client.secret);
  const tokens = await requestToken(body, requestSignal, true);
  const projectId = await discoverProject(tokens.access, requestSignal, credentials.projectId);
  return {
    ...credentials,
    ...tokens,
    refresh: tokens.refresh ?? credentials.refresh,
    projectId,
    oauthClientId: client.id,
  };
}
