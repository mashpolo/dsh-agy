import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import {
  AttachmentId,
  type ImageAttachmentRef,
  type ImageMediaType,
  type SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-working-directory';
import {
  defineTool,
  ToolArgsError,
  ToolContextUnavailableError,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import { executeAntigravitySearch } from 'pi-antigravity/src/search/search.js';
import {
  executeAntigravityWebFetch,
  formatWebFetchHeader,
  formatWebFetchResult,
  validateFetchTarget,
} from 'pi-antigravity/src/web-fetch/web-fetch.js';
import {
  generateAntigravityImageContent,
  IMAGE_ASPECT_RATIOS,
  type GeneratedImage,
} from 'pi-antigravity/src/image/image.js';
import { redactSecrets } from 'pi-antigravity/src/utils/security.js';

export interface ToolsConfig {
  maxPageChars?: number;
}
export interface ToolAuth {
  getApiKey(): Promise<string>;
}

/** The host owns filesystem access and durable images; upstream only makes API calls. */
export interface ToolHost {
  workingDirectory(exec: ToolRunContext): Promise<string>;
  resolvePath(path: string, cwd: string, signal: AbortSignal): Promise<string>;
  readBytes(path: string, signal: AbortSignal): Promise<Uint8Array>;
  savePage(text: string, exec: ToolRunContext): Promise<string>;
  saveImages(images: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>;
}

export interface ToolServices {
  search: typeof executeAntigravitySearch;
  readUrl: typeof executeAntigravityWebFetch;
  generateImage: typeof generateAntigravityImageContent;
}

const services: ToolServices = {
  search: executeAntigravitySearch,
  readUrl: executeAntigravityWebFetch,
  generateImage: generateAntigravityImageContent,
};
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const imageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: {
      type: 'string',
      enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      required: true,
    },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
} as const;

function requiredText(value: string, name: string): string {
  const text = value.trim();
  if (!text) throw new ToolArgsError([`${name} must not be empty`]);
  return text;
}

async function run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  try {
    const result = await action();
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}

function assertInside(cwd: string, path: string): void {
  const local = relative(cwd, path);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new ToolArgsError(['Reference images must be inside the session working directory']);
  }
}

function imageType(data: Uint8Array): ImageMediaType {
  const bytes = Buffer.from(data);
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  throw new ToolArgsError(['Use PNG, JPEG, WebP or GIF reference images']);
}

async function referenceImages(
  paths: readonly string[],
  host: ToolHost,
  exec: ToolRunContext,
): Promise<GeneratedImage[]> {
  if (paths.length > 4) throw new ToolArgsError(['At most four reference images are supported']);
  if (!paths.length) return [];
  const cwd = await host.workingDirectory(exec);
  const root = await host.resolvePath('.', cwd, exec.signal);
  const images: GeneratedImage[] = [];
  for (const path of paths) {
    if (isAbsolute(path))
      throw new ToolArgsError(['Reference image paths must be project-relative']);
    assertInside(root, join(root, path));
    const target = await host.resolvePath(path, cwd, exec.signal);
    assertInside(root, target);
    const data = await host.readBytes(target, exec.signal);
    if (data.byteLength > MAX_REFERENCE_BYTES)
      throw new ToolArgsError(['Each reference image must be at most 10 MB']);
    images.push({ data: Buffer.from(data).toString('base64'), mimeType: imageType(data) });
  }
  return images;
}

/** Three independently registered tools with network services injectable at the boundary. */
export function createTools(
  auth: ToolAuth,
  host: ToolHost,
  config: ToolsConfig = {},
  api: ToolServices = services,
): ToolDefinition[] {
  const maxPageChars = config.maxPageChars ?? 60000;
  if (!Number.isSafeInteger(maxPageChars) || maxPageChars < 1000)
    throw new Error('maxPageChars must be an integer of at least 1000');
  return [
    defineTool({
      name: 'antigravity_search',
      description:
        'Search Google through Antigravity and return findings with source citations. Use for current information and research.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Search query or research question.',
        },
        instruction: { type: 'string', description: 'Optional research focus.' },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional public URLs to analyze.',
        },
        thinking: { type: 'boolean', description: 'Enable deeper research reasoning.' },
      },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: (args, exec) =>
        run(exec.signal, async () => {
          const query = requiredText(args.query, 'query');
          const urls = args.urls?.map(validateFetchTarget);
          return api.search({
            ...args,
            query,
            urls,
            apiKey: await auth.getApiKey(),
            signal: exec.signal,
          });
        }),
    }),
    defineTool({
      name: 'antigravity_read_url',
      description:
        'Read a public web page through the Antigravity crawler as Markdown. Long pages are saved in the session directory for file tools. Cannot sign in or execute JavaScript.',
      parameters: { url: { type: 'string', required: true, description: 'Public HTTP(S) URL.' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true }, savedPath: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: (args, exec) =>
        run(exec.signal, async () => {
          const url = validateFetchTarget(args.url);
          const result = await api.readUrl({
            url,
            apiKey: await auth.getApiKey(),
            signal: exec.signal,
          });
          const full = formatWebFetchHeader(result) + result.content;
          if (full.length <= maxPageChars)
            return { text: formatWebFetchResult({ ...result, maxChars: maxPageChars }) };
          const savedPath = await host.savePage(full, exec);
          const footer = `\n\n[Full retrieved page saved to ${savedPath}. Read the remaining content with file tools.]`;
          return {
            text: formatWebFetchResult({ ...result, maxChars: maxPageChars }, footer),
            savedPath,
          };
        }),
    }),
    defineTool({
      name: 'antigravity_generate_image',
      description:
        'Generate images through Antigravity, optionally guided by project-relative reference images. Returns images stored durably by DeepSeek Harness.',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'Description of the image to create.',
        },
        aspectRatio: { type: 'string', enum: IMAGE_ASPECT_RATIOS },
        model: { type: 'string', description: 'Optional Antigravity image model ID.' },
        referenceImages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to four project-relative PNG/JPEG/WebP/GIF paths, each at most 10 MB.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            model: { type: 'string', required: true },
            images: { type: 'array', items: imageSchema, required: true },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: value.text },
          ...value.images.map((image) => ({
            type: 'image' as const,
            attachment: { ...image, attachmentId: AttachmentId(image.attachmentId) },
          })),
        ],
      },
      execute: (args, exec) =>
        run(exec.signal, async () => {
          const prompt = requiredText(args.prompt, 'prompt');
          const inputImages = await referenceImages(args.referenceImages ?? [], host, exec);
          const result = await api.generateImage({
            prompt,
            aspectRatio: args.aspectRatio,
            model: args.model,
            inputImages,
            apiKey: await auth.getApiKey(),
            signal: exec.signal,
          });
          exec.signal.throwIfAborted();
          const inputs = result.images.map((image, index) => {
            const data = Buffer.from(image.data, 'base64');
            const mediaType = imageType(data);
            if (mediaType !== image.mimeType)
              throw new Error('Generated image data does not match its media type');
            return {
              data,
              mediaType,
              name: `antigravity-${index + 1}.${mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice(6)}`,
            };
          });
          const images = await host.saveImages(inputs);
          return {
            text: result.text.join('\n') || `Generated ${images.length} image(s).`,
            model: result.model,
            images: images.map((image) => ({ ...image })),
          };
        }),
    }),
  ];
}

export function registerTools(ctx: Context, auth: ToolAuth, config: ToolsConfig = {}): void {
  const workingDirectory = async (exec: ToolRunContext): Promise<string> => {
    if (!exec.agent) throw new ToolContextUnavailableError('This tool needs an agent session');
    return ctx.workingDirectory.ensure(exec.agent, exec.signal);
  };
  const host: ToolHost = {
    workingDirectory,
    resolvePath: async (path, cwd, signal) =>
      ctx.fs.processPath(await ctx.fs.resolve(path, { cwd, signal })),
    readBytes: async (path, signal) =>
      ctx.fs.readBytes(await ctx.fs.resolve(path, { signal }), signal, MAX_REFERENCE_BYTES),
    savePage: async (text, exec) => {
      const cwd = await workingDirectory(exec);
      const target = await ctx.fs.resolve(
        join('.dsh', 'antigravity', 'pages', `${randomUUID()}.md`),
        { cwd, signal: exec.signal },
      );
      await ctx.fs.writeText(target, text, undefined, exec.signal);
      return ctx.fs.processPath(target);
    },
    saveImages: (images) => ctx.attachments.saveImages(images),
  };
  for (const tool of createTools(auth, host, config)) ctx.tools.register(tool);
}
