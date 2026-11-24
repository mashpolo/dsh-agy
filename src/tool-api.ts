import { randomUUID } from 'node:crypto';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { isRecord, parseApiKey, postRpc } from './client.js';
import { sseJson } from './sse.js';
import { validateFetchTarget } from './web-page.js';

interface Session {
  apiKey: string;
  signal: AbortSignal;
}

export interface GeneratedImage {
  mimeType: string;
  data: string;
}

export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const;

function candidate(value: unknown) {
  if (!isRecord(value) || value.error)
    throw new Error('Antigravity returned an invalid generation response');
  const payload = isRecord(value.response) ? value.response : value;
  if (payload.error) throw new Error('Antigravity reported a generation error');
  return Array.isArray(payload.candidates) && isRecord(payload.candidates[0])
    ? payload.candidates[0]
    : undefined;
}

function visibleParts(item: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const content = item?.content;
  return isRecord(content) && Array.isArray(content.parts)
    ? content.parts.filter(isRecord).filter((part) => !part.thought)
    : [];
}

function isMissing(error: unknown) {
  return error instanceof LlmError && error.failure.status === 404;
}

function sources(metadata: unknown): string[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.groundingChunks)) return [];
  const links = new Map<string, string>();
  for (const chunk of metadata.groundingChunks) {
    if (!isRecord(chunk) || !isRecord(chunk.web) || typeof chunk.web.uri !== 'string') continue;
    let url: string;
    try {
      url = validateFetchTarget(chunk.web.uri);
    } catch {
      continue;
    }
    const title = typeof chunk.web.title === 'string' ? chunk.web.title : new URL(url).hostname;
    links.set(url, title.replace(/[\[\]\\\r\n]/g, ' '));
  }
  return Array.from(
    links,
    ([url, label], i) => `${i + 1}. [${label}](<${url.replace(/>/g, '%3E')}>)`,
  );
}

export async function executeAntigravitySearch(
  options: Session & {
    query: string;
    instruction?: string;
    urls?: string[];
    thinking?: boolean;
  },
): Promise<string> {
  const { token, projectId } = parseApiKey(options.apiKey);
  const urls = options.urls?.map(validateFetchTarget) ?? [];
  const prompt = [options.query, options.instruction, ...urls].filter(Boolean).join('\n\n');
  const tools = urls.length ? [{ googleSearch: {} }, { urlContext: {} }] : [{ googleSearch: {} }];
  const request = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools,
    generationConfig: options.thinking
      ? { thinkingConfig: { thinkingBudget: 4096, includeThoughts: false } }
      : undefined,
  };
  const models = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash'];
  for (const model of models) {
    let response: Response;
    try {
      response = await postRpc(
        'generateContent',
        {
          model,
          project: projectId,
          request,
          requestType: 'agent',
          requestId: randomUUID(),
        },
        token,
        options.signal,
      );
    } catch (error) {
      if (isMissing(error) && model !== models.at(-1)) continue;
      throw error;
    }
    const item = candidate(await response.json());
    const answer = visibleParts(item)
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (!answer) throw new Error('Antigravity search returned no answer');
    const links = sources(item?.groundingMetadata);
    return links.length ? answer + '\n\nSources\n' + links.join('\n') : answer;
  }
  throw new Error('No Antigravity search model available');
}

export async function generateAntigravityImageContent(
  options: Session & {
    prompt: string;
    model?: string;
    aspectRatio?: string;
    inputImages?: GeneratedImage[];
  },
): Promise<{ model: string; text: string[]; images: GeneratedImage[] }> {
  const { token, projectId } = parseApiKey(options.apiKey);
  const models = options.model
    ? [options.model]
    : ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3-pro-image-preview'];
  const parts = [
    { text: options.prompt },
    ...(options.inputImages ?? []).map((inlineData) => ({ inlineData })),
  ];
  const request = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      candidateCount: 1,
      imageConfig: { aspectRatio: options.aspectRatio ?? '1:1' },
    },
  };
  for (const model of models) {
    const body = {
      model,
      project: projectId,
      requestType: 'image_gen',
      requestId: `image_gen/${Date.now()}/${randomUUID()}/1`,
      request,
    };
    let events: AsyncIterable<unknown> | unknown[];
    try {
      const response = await postRpc('generateContent', body, token, options.signal);
      events = [await response.json()];
    } catch (error) {
      if (!isMissing(error)) throw error;
      let response: Response;
      try {
        response = await postRpc('streamGenerateContent', body, token, options.signal, {
          stream: true,
        });
      } catch (streamError) {
        if (isMissing(streamError) && model !== models.at(-1)) continue;
        throw streamError;
      }
      events = sseJson(response, options.signal);
    }
    const text: string[] = [];
    const images: GeneratedImage[] = [];
    for await (const event of events) {
      for (const part of visibleParts(candidate(event))) {
        if (typeof part.text === 'string') text.push(part.text);
        const image = part.inlineData ?? part.inline_data;
        if (!isRecord(image)) continue;
        const mimeType = image.mimeType ?? image.mime_type;
        if (typeof mimeType === 'string' && typeof image.data === 'string' && image.data)
          images.push({ mimeType, data: image.data });
      }
    }
    if (!images.length) throw new Error('Antigravity returned no image');
    return { model, text, images };
  }
  throw new Error('No Antigravity image model available');
}
