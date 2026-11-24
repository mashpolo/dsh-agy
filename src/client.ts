import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm';

const endpoints = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];
const reads = new Set([
  'loadCodeAssist',
  'retrieveUserQuotaSummary',
  'listCloudAICompanionProjects',
  'fetchAvailableModels',
  'rewriteUri',
  'fetchFromTrawlerCache',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseApiKey(raw: string): { token: string; projectId: string } {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      typeof value.token === 'string' &&
      /^[!-~]+$/.test(value.token) &&
      typeof value.projectId === 'string' &&
      /^[!-~]+$/.test(value.projectId)
    ) {
      return { token: value.token, projectId: value.projectId };
    }
  } catch {
    /* Never include a JSON parsing diagnostic containing credential bytes. */
  }
  throw new LlmError(
    'Invalid Antigravity session. Run dsh-antigravity-login.',
    'INVALID_CREDENTIAL',
  );
}

async function request(
  endpoint: string,
  method: string,
  body: unknown,
  token: string,
  signal: AbortSignal,
  stream = false,
) {
  signal.throwIfAborted();
  const headers = new Headers(attributionHeaders());
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', stream ? 'text/event-stream' : 'application/json');
  headers.set('Authorization', 'Bearer ' + token);
  let response: Response;
  try {
    response = await fetch(endpoint + '/v1internal:' + method + (stream ? '?alt=sse' : ''), {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new LlmError('网络请求失败', 'TRANSPORT');
  }
  if (!response.ok) {
    await response.body?.cancel();
    const { status } = response;
    throw new LlmError(
      'HTTP ' + status,
      status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : `HTTP_${status}`,
      { status },
    );
  }
  return response;
}

export async function postRpc(
  method: string,
  body: unknown,
  token: string,
  signal: AbortSignal,
  options: { stream?: boolean } = {},
): Promise<Response> {
  const readOnly = reads.has(method);
  for (const endpoint of endpoints) {
    try {
      const deadline = readOnly ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : signal;
      return await request(endpoint, method, body, token, deadline, options.stream);
    } catch (error) {
      signal.throwIfAborted();
      const status = error instanceof LlmError ? error.failure.status : undefined;
      // A generation may already have run after a network failure. Retry only explicit 404s.
      if (
        endpoint === endpoints.at(-1) ||
        (!readOnly && status !== 404) ||
        status === 401 ||
        status === 403 ||
        status === 429
      )
        throw error;
    }
  }
  throw new LlmError('没有可用的服务端点', 'TRANSPORT');
}

type CatalogEntry = Record<string, unknown> & { quotaInfo?: Record<string, unknown> };
export async function fetchAvailableModelsCatalog(
  token: string,
  projectId: string,
  signal = new AbortController().signal,
) {
  const replies = await Promise.allSettled(
    endpoints.map(async (endpoint) => {
      const response = await request(
        endpoint,
        'fetchAvailableModels',
        { project: projectId },
        token,
        AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      );
      const raw: unknown = await response.json();
      if (!isRecord(raw) || !isRecord(raw.models))
        throw new LlmError('模型目录格式不正确', 'INVALID_CATALOG');
      return raw;
    }),
  );
  signal.throwIfAborted();
  if (replies.every((reply) => reply.status === 'rejected')) {
    const denied = replies.find(
      (reply) => reply.reason instanceof LlmError && reply.reason.code === 'AUTH',
    );
    throw (denied ?? replies[0]).reason;
  }
  const models: Record<string, CatalogEntry> = {};
  const sorts: unknown[] = [];
  for (const reply of replies) {
    if (reply.status === 'rejected') continue;
    const { models: directory, agentModelSorts } = reply.value;
    if (Array.isArray(agentModelSorts)) sorts.push(...agentModelSorts);
    if (!isRecord(directory)) continue;
    for (const [id, entry] of Object.entries(directory)) {
      if (isRecord(entry))
        models[id] = {
          ...models[id],
          ...entry,
          quotaInfo: isRecord(entry.quotaInfo) ? entry.quotaInfo : models[id]?.quotaInfo,
        };
    }
  }
  if (!Object.keys(models).length) throw new LlmError('无法获取模型目录', 'DISCOVERY_FAILED');
  return { data: { models, ...(sorts.length ? { agentModelSorts: sorts } : {}) } };
}
