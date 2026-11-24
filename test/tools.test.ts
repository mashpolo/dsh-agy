import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { brandString } from '@deepseek-ai/dsh-brand';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import {
  validateJsonSchemaValue,
  type ToolDefinition,
  type ToolExecutionToken,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import { createTools, type ToolHost, type ToolServices } from '../src/tools.js';

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=',
  'base64',
);

function execution(signal = new AbortController().signal): ToolRunContext {
  return {
    callId: brandString<ToolCallId>('call-1'),
    rootCallId: brandString<ToolCallId>('call-1'),
    token: Symbol('tool-test') as ToolExecutionToken,
    name: 'test',
    arguments: {},
    signal,
    deferContext() {},
    concludeTurn() {},
  };
}

async function fixture(overrides: Partial<ToolServices> = {}, maxPageChars = 60000) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-antigravity-tools-'));
  roots.push(cwd);
  let authCalls = 0;
  const host: ToolHost = {
    workingDirectory: async () => cwd,
    resolvePath: async (path, directory) => realpath(resolve(directory, path)),
    readBytes: async (path, signal) => readFile(path, { signal }),
    savePage: async (text) => {
      const directory = join(cwd, '.dsh', 'antigravity', 'pages');
      await mkdir(directory, { recursive: true });
      const path = join(directory, 'page.md');
      await writeFile(path, text);
      return path;
    },
    saveImages: async (images) =>
      images.map((image, index) => ({
        attachmentId: AttachmentId(`image-${index}`),
        mediaType: image.mediaType,
        bytes: image.data.length,
        width: 1,
        height: 1,
        name: image.name,
      })),
  };
  const services: ToolServices = {
    search: async () => 'Found the official documentation. [1](https://example.com/docs)',
    readUrl: async ({ url }) => ({
      requestedUrl: url,
      resolvedUrl: url,
      content: 'Page content',
      source: 'cache',
      bytes: 12,
      truncated: false,
      partial: false,
    }),
    generateImage: async () => ({
      images: [{ data: png.toString('base64'), mimeType: 'image/png' }],
      text: ['Generated image'],
      model: 'gemini-3.1-flash-image',
    }),
    ...overrides,
  };
  const tools = createTools(
    {
      getApiKey: async () => {
        authCalls++;
        return 'test-credential';
      },
    },
    host,
    { maxPageChars },
    services,
  );
  const tool = (name: string): ToolDefinition => {
    const found = tools.find((value) => value.name === name);
    assert.ok(found, `Missing ${name}`);
    return found;
  };
  return { cwd, tools, tool, authCalls: () => authCalls };
}

async function invoke(tool: ToolDefinition, args: unknown, exec = execution()) {
  const value = await tool.execute(args, exec);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, ''), []);
  return { value, content: tool.output.render(args, value as JsonValue) };
}

test('search forwards query, instructions and cancellation and renders citations', async () => {
  const controller = new AbortController();
  const f = await fixture({
    search: async (options) => {
      assert.equal(options.query, 'official docs');
      assert.equal(options.instruction, 'Use primary sources');
      assert.deepEqual(options.urls, ['https://example.com/docs']);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.apiKey, 'test-credential');
      return 'Answer [1](https://example.com/docs)';
    },
  });
  const result = await invoke(
    f.tool('antigravity_search'),
    {
      query: 'official docs',
      instruction: 'Use primary sources',
      urls: ['https://example.com/docs'],
    },
    execution(controller.signal),
  );
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Answer [1](https://example.com/docs)' },
  ]);
});

test('invalid tool arguments and private URLs fail before credentials or network', async () => {
  const f = await fixture();
  await assert.rejects(() => invoke(f.tool('antigravity_search'), { query: 42 }));
  await assert.rejects(() => invoke(f.tool('antigravity_search'), { query: '   ' }), /query/i);
  await assert.rejects(
    () => invoke(f.tool('antigravity_read_url'), { url: 'http://127.0.0.1/secret' }),
    /private|local/i,
  );
  await assert.rejects(() =>
    invoke(f.tool('antigravity_generate_image'), { prompt: 'x', aspectRatio: '7:13' }),
  );
  assert.equal(f.authCalls(), 0);
});

test('long pages keep a bounded preview and save their complete content', async () => {
  const body = 'Read the complete document.\n'.repeat(100);
  const f = await fixture(
    {
      readUrl: async ({ url }) => ({
        requestedUrl: url,
        resolvedUrl: url,
        content: body,
        source: 'live',
        bytes: body.length,
        truncated: false,
        partial: false,
      }),
    },
    1000,
  );
  const result = await invoke(f.tool('antigravity_read_url'), { url: 'https://example.com/docs' });
  assert.ok(
    typeof result.value === 'object' && result.value !== null && 'savedPath' in result.value,
  );
  assert.ok(typeof result.value.savedPath === 'string');
  const path = result.value.savedPath;
  assert.ok(path.startsWith(f.cwd));
  const full = await readFile(path, 'utf8');
  assert.ok(full.includes(body));
  assert.ok(result.content[0]?.type === 'text');
  assert.ok(result.content[0].text.length <= 1000);
  assert.ok(result.content[0].text.includes(path));
});

test('reference images resolve in the session directory and generated images become durable blocks', async () => {
  let seenInput: string | undefined;
  const f = await fixture({
    generateImage: async (options) => {
      seenInput = options.inputImages?.[0]?.data;
      return {
        images: [{ data: png.toString('base64'), mimeType: 'image/png' }],
        text: [],
        model: 'gemini-3.1-flash-image',
      };
    },
  });
  await writeFile(join(f.cwd, 'ref.png'), png);
  const result = await invoke(f.tool('antigravity_generate_image'), {
    prompt: 'Draw a tree',
    referenceImages: ['ref.png'],
  });
  assert.equal(seenInput, png.toString('base64'));
  const image = result.content.find((block) => block.type === 'image');
  assert.ok(image?.type === 'image');
  assert.equal(image.attachment.mediaType, 'image/png');
  assert.equal(image.attachment.width, 1);
  assert.equal(image.attachment.bytes, png.length);
});

test('reference images cannot escape the session directory via a path or symlink', async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'dsh-antigravity-outside-'));
  roots.push(outside);
  await writeFile(join(outside, 'secret.png'), png);
  await symlink(join(outside, 'secret.png'), join(f.cwd, 'link.png'));
  for (const path of [join(outside, 'secret.png'), 'link.png', '../secret.png']) {
    await assert.rejects(() =>
      invoke(f.tool('antigravity_generate_image'), { prompt: 'Draw', referenceImages: [path] }),
    );
  }
  assert.equal(f.authCalls(), 0);
});

test('cancelled tools do not acquire credentials and upstream errors are redacted', async () => {
  const f = await fixture({
    search: async () => {
      throw new Error('Authorization: Bearer ya29.private-access-token');
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    invoke(f.tool('antigravity_search'), { query: 'x' }, execution(controller.signal)),
  );
  assert.equal(f.authCalls(), 0);
  await assert.rejects(
    () => invoke(f.tool('antigravity_search'), { query: 'x' }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('private-access-token'));
      return true;
    },
  );
});
