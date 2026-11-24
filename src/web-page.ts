import { isIP } from 'node:net';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { isRecord, parseApiKey, postRpc } from './client.js';

const maxResponseBytes = 5 * 1024 * 1024;

function localHost(name: string): boolean {
  if (isIP(name) === 6) {
    // Public unicast addresses are in 2000::/3. Exclude documentation, Teredo and 6to4.
    return !/^[23]/.test(name) || /^(2001:(db8:|0:|:)|2002:)/.test(name);
  }
  if (isIP(name) === 4) {
    const [a, b, c] = name.split('.').map(Number);
    return (
      [0, 10, 127].includes(a) ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  return (
    !name.includes('.') ||
    /\.(localhost|local|internal|localdomain|lan|home|test|invalid|onion)$/.test(name) ||
    /(^|\.)home\.arpa$/.test(name)
  );
}

export function validateFetchTarget(value: string): string {
  const url = URL.parse(value);
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('A public HTTP(S) URL without credentials is required');
  const host = url.hostname.replace(/^\[|\]$|\.$/g, '');
  if (localHost(host)) throw new Error('Private or local web addresses are not supported');
  return url.href;
}

interface Page {
  requestedUrl: string;
  resolvedUrl: string;
  content: string;
  source: 'cache' | 'live';
}

export function formatWebFetchHeader(page: Page): string {
  return `URL: ${page.resolvedUrl}\nSource: Antigravity crawler (${page.source})\n\n`;
}

export function formatWebFetchResult(page: Page & { maxChars: number }, footer = ''): string {
  const full = formatWebFetchHeader(page) + page.content;
  return (full.slice(0, Math.max(0, page.maxChars - footer.length)) + footer).slice(
    0,
    page.maxChars,
  );
}

async function readCrawlerResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('The crawler returned an empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as ReadableStream<Uint8Array> &
    AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxResponseBytes) throw new Error('The crawler response exceeds 5 MiB');
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new Error('The crawler returned invalid JSON');
  }
  if (!isRecord(value) || value.error) throw new Error('Unexpected crawler response');
  return isRecord(value.response) ? value.response : value;
}

function firstText(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && !!value.trim());
}

async function renderContent(page: Record<string, unknown>): Promise<string> {
  const input = firstText(page.content, page.markdownContent);
  if (!input) return '';
  const type = firstText(
    page.contentType,
    page.content_type,
    page.mimeType,
    page.mime_type,
  )?.toLowerCase();
  if (type?.includes('pdf') || input.startsWith('%PDF-'))
    throw new Error('PDF pages are not supported');
  if (
    type?.includes('html') ||
    /^\s*<(?:!doctype\s+html|html|head|body|main|article|div|h[1-6]|p)\b/i.test(input)
  ) {
    const [{ default: Turndown }, { gfm }] = await Promise.all([
      import('turndown'),
      import('turndown-plugin-gfm'),
    ]);
    return new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
      .use(gfm)
      .remove(['script', 'style', 'noscript', 'iframe', 'nav'])
      .turndown(input)
      .trim();
  }
  if (type && !(type.startsWith('text/') || type.includes('json') || type.includes('xml')))
    throw new Error('Unsupported crawler content type');
  return input.trim();
}

export async function executeAntigravityWebFetch(options: {
  url: string;
  apiKey: string;
  signal: AbortSignal;
}): Promise<Page> {
  const requestedUrl = validateFetchTarget(options.url);
  const { token } = parseApiKey(options.apiKey);
  const call = async (method: string, body: Record<string, unknown>) =>
    readCrawlerResponse(await postRpc(method, body, token, options.signal));
  const redirect = await call('rewriteUri', { originalUri: requestedUrl });
  const resolvedUrl = validateFetchTarget(
    firstText(redirect.redirectUri, redirect.redirect_uri, redirect.rewrittenUri) ?? requestedUrl,
  );
  let content = '';
  try {
    content = await renderContent(await call('fetchFromTrawlerCache', { url: resolvedUrl }));
  } catch (error) {
    if (!(error instanceof LlmError && error.failure.status === 404)) throw error;
  }
  if (content) return { requestedUrl, resolvedUrl, content, source: 'cache' };
  content = await renderContent(
    await call('fetchFromTrawlerCache', { url: resolvedUrl, liveFetch: true }),
  );
  if (!content) throw new Error('The crawler returned no readable page content');
  return { requestedUrl, resolvedUrl, content, source: 'live' };
}
