import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-fs';
import { requestImageDimensions, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import {
  LlmError,
  ToolCallId,
  fileHandleText,
  offloadedImageText,
  requestImageHandleText,
  resolveImageAttachmentAccess,
  textOnlyImageText,
  type ContentBlock,
  type GenerateOptions,
  type ReplayEnvelope,
  type RequestMessage,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm';
import { isRecord } from './client.js';
import { sseJson } from './sse.js';
import { canonicalId, selectRoute, type ModelDefinition } from './models.js';

type Part = Record<string, unknown>;
type Content = { role: 'user' | 'model'; parts: Part[] };
const IMAGE_MAX_PIXELS = 2048 * 2048;
const IMAGE_MAX_BYTES = 1024 * 1024;
export function imageTarget(image: ImageAttachmentRef) {
  return {
    ...requestImageDimensions(image.width, image.height, IMAGE_MAX_PIXELS),
    maxBytes: IMAGE_MAX_BYTES,
  };
}

function replayBlocks(
  message: Extract<RequestMessage, { role: 'assistant' }>,
  model: ModelDefinition,
  warn: () => void,
): Record<string, unknown>[] {
  const envelope = message.source.replayState;
  if (envelope === undefined) return [];
  if (!isRecord(envelope) || !isRecord(envelope.response) || !Array.isArray(envelope.blocks)) {
    warn();
    return [];
  }
  const response = envelope.response;
  const sourceMatches =
    message.source.provider === 'antigravity' &&
    (message.source.model === model.id ||
      message.source.model === canonicalId(model) ||
      Object.values(model.routes).includes(message.source.model));
  const formatMatches =
    (response.kind === 'dsh-antigravity' && response.version === 1) ||
    (response.kind === 'pi-ai' && response.version === 2 && response.api === 'antigravity-api');
  if (
    !sourceMatches ||
    !formatMatches ||
    response.provider !== 'antigravity' ||
    response.model !== message.source.model ||
    envelope.blocks.length !== message.content.length
  ) {
    warn();
    return [];
  }
  const blocks = envelope.blocks;
  if (
    !blocks.every((value, index) => isRecord(value) && value.type === message.content[index].type)
  ) {
    warn();
    return [];
  }
  return blocks.filter(isRecord);
}
function signature(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const value = metadata.thoughtSignature ?? metadata.thinkingSignature ?? metadata.textSignature;
  return typeof value === 'string' && value.length ? value : undefined;
}
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const args: unknown = JSON.parse(raw);
    if (isRecord(args)) return args;
  } catch {
    /* Never quote argument text in protocol errors. */
  }
  throw new LlmError('Tool call arguments must be a JSON object.', 'MALFORMED_RESPONSE');
}
async function ordinaryParts(
  content: readonly ContentBlock[],
  ctx: Context,
  model: ModelDefinition,
  signal: AbortSignal,
): Promise<Part[]> {
  const result: Part[] = [];
  const attachments = ctx.get('attachments');
  const mapPath = (path: string) => ctx.get('fs')?.processPathFromHostPath(path);
  for (const block of content) {
    signal.throwIfAborted();
    if (block.type === 'text' || block.type === 'reasoning') {
      if (block.text) result.push({ text: block.text });
      continue;
    }
    if (block.type === 'file') {
      const hostPath = attachments?.fileHostPath(block.attachment);
      result.push({
        text: fileHandleText(
          block.attachment,
          hostPath === undefined ? undefined : mapPath(hostPath),
        ),
      });
      continue;
    }
    if (block.type === 'image') {
      const access =
        attachments && resolveImageAttachmentAccess(attachments, mapPath, block.attachment);
      if (block.offloaded) {
        result.push({ text: offloadedImageText(block.attachment, access) });
        continue;
      }
      if (!model.input.includes('image')) {
        result.push({ text: textOnlyImageText(block.attachment) });
        continue;
      }
      if (!attachments)
        throw new LlmError(
          'Image attachments are unavailable in this session.',
          'UNSUPPORTED_CONTENT',
        );
      const image = await attachments.readImageRequest(
        block.attachment,
        imageTarget(block.attachment),
        signal,
      );
      result.push({ text: requestImageHandleText(block.attachment, image, access) });
      result.push({
        inlineData: { mimeType: image.mediaType, data: Buffer.from(image.data).toString('base64') },
      });
    }
  }
  return result;
}
function append(contents: Content[], role: Content['role'], parts: Part[]): void {
  if (!parts.length) return;
  const previous = contents.at(-1);
  if (previous?.role === role) previous.parts.push(...parts);
  else contents.push({ role, parts });
}
function schemaForTool(
  value: unknown,
  root: Record<string, unknown>,
  visited = new Set<string>(),
): unknown {
  if (Array.isArray(value)) return value.map((item) => schemaForTool(item, root, visited));
  if (!isRecord(value)) return value;
  if (typeof value.$ref === 'string') {
    if (!value.$ref.startsWith('#/') || visited.has(value.$ref))
      throw new LlmError('This tool schema contains an unsupported reference.', 'INVALID_REQUEST');
    let target: unknown = root;
    for (const key of value.$ref
      .slice(2)
      .split('/')
      .map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~')))
      target = isRecord(target) ? target[key] : undefined;
    if (!isRecord(target))
      throw new LlmError('This tool schema contains an unresolved reference.', 'INVALID_REQUEST');
    return schemaForTool(target, root, new Set([...visited, value.$ref]));
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['$schema', '$defs', 'definitions', '$id'].includes(key))
      .map(([key, item]) => [key, schemaForTool(item, root, visited)]),
  );
}

/** Translate DSH history directly to the service's content protocol. */
export async function conversationRequest(
  options: GenerateOptions,
  model: ModelDefinition,
  projectId: string,
  ctx: Context,
  signal: AbortSignal,
  warn: () => void,
): Promise<Record<string, unknown>> {
  const contents: Content[] = [];
  const system: string[] = options.system ? [options.system] : [];
  const calls = new Map<string, { name: string; native: boolean }>();
  for (const message of options.messages) {
    signal.throwIfAborted();
    if (message.role === 'assistant') {
      const metadata = replayBlocks(message, model, warn);
      const groupSigned = message.content.some(
        (block, index) => block.type === 'tool-call' && signature(metadata[index]),
      );
      const parts: Part[] = [];
      for (const [index, block] of message.content.entries()) {
        const signed = signature(metadata[index]);
        if (block.type === 'tool-call') {
          const native = !model.id.startsWith('gemini') || groupSigned;
          calls.set(block.id, { name: block.name, native });
          parts.push(
            native
              ? {
                  functionCall: {
                    id: block.id,
                    name: block.name,
                    args: parseArguments(block.arguments),
                  },
                  ...(signed ? { thoughtSignature: signed } : {}),
                }
              : { text: `[Previous tool call ${block.name} (${block.id})]\n${block.arguments}` },
          );
        } else if (block.type === 'text' || block.type === 'reasoning') {
          if (block.text || signed)
            parts.push({
              text: block.text,
              ...(block.type === 'reasoning' && signed ? { thought: true } : {}),
              ...(signed ? { thoughtSignature: signed } : {}),
            });
        } else parts.push(...(await ordinaryParts([block], ctx, model, signal)));
      }
      append(contents, 'model', parts);
      continue;
    }
    const parts = await ordinaryParts(message.content, ctx, model, signal);
    if (message.role === 'system' && !contents.length) {
      for (const part of parts) {
        if (typeof part.text !== 'string')
          throw new LlmError('System instructions must be text.', 'UNSUPPORTED_CONTENT');
        system.push(part.text);
      }
      continue;
    }
    if (message.role === 'tool') {
      const call = calls.get(message.toolCallId);
      const text = parts
        .flatMap((part) => (typeof part.text === 'string' ? [part.text] : []))
        .join('\n');
      if (call?.native) {
        append(contents, 'user', [
          {
            functionResponse: {
              id: message.toolCallId,
              name: call.name,
              response: message.isError ? { error: text } : { output: text },
            },
          },
          ...parts.filter((part) => 'inlineData' in part),
        ]);
      } else
        append(contents, 'user', [
          {
            text: `[Tool result ${call?.name ?? message.toolCallId}${message.isError ? ' (error)' : ''}]\n${text}`,
          },
          ...parts.filter((part) => 'inlineData' in part),
        ]);
    } else
      append(
        contents,
        'user',
        message.role === 'system' ? [{ text: '[Updated system instructions]' }, ...parts] : parts,
      );
  }
  for (const content of contents)
    if (content.role === 'user')
      content.parts.sort(
        (a, b) => Number('functionResponse' in b) - Number('functionResponse' in a),
      );
  const route = selectRoute(model, options.reasoningEffort);
  const generationConfig = {
    maxOutputTokens: options.maxTokens ?? model.maxTokens,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(route.thinkingConfig ? { thinkingConfig: route.thinkingConfig } : {}),
  };
  const tools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    [model.id.startsWith('gemini') ? 'parametersJsonSchema' : 'parameters']: schemaForTool(
      tool.parameters,
      tool.parameters,
    ),
  }));
  return {
    project: projectId,
    model: route.runtimeId,
    requestType: 'agent',
    userAgent: 'dsh-antigravity',
    requestId: `dsh-${randomUUID()}`,
    request: {
      contents,
      sessionId: options.sessionId ?? randomUUID(),
      generationConfig,
      ...(system.length
        ? { systemInstruction: { role: 'user', parts: [{ text: system.join('\n\n') }] } }
        : {}),
      ...(tools?.length ? { tools: [{ functionDeclarations: tools }] } : {}),
    },
  };
}

type StreamBlock = { block: ContentBlock; signature?: string };
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
function tokenUsage(raw: Record<string, unknown>): TokenUsage {
  const prompt = count(raw.promptTokenCount),
    cached = Math.min(prompt, count(raw.cachedContentTokenCount)),
    thoughts = count(raw.thoughtsTokenCount),
    output = count(raw.candidatesTokenCount) + thoughts;
  return {
    inputTokens: prompt - cached,
    outputTokens: output,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(thoughts ? { reasoningTokens: thoughts } : {}),
    ...(typeof raw.totalTokenCount === 'number' && raw.totalTokenCount >= prompt + output
      ? { totalTokens: count(raw.totalTokenCount) }
      : {}),
  };
}
function wireResponse(event: unknown): Record<string, unknown> {
  if (!isRecord(event))
    throw new LlmError('Antigravity returned an invalid stream event.', 'MALFORMED_RESPONSE');
  const result = isRecord(event.response) ? event.response : event;
  if (isRecord(event.error) || isRecord(result.error))
    throw new LlmError('Antigravity rejected the streaming request.', 'SERVER');
  if (isRecord(result.promptFeedback) && result.promptFeedback.blockReason)
    throw new LlmError('Antigravity declined this request.', 'CONTENT_REFUSED');
  return result;
}

/** Adapt native SSE without loading a second agent/model runtime. */
export async function* conversationChunks(
  response: Response,
  model: ModelDefinition,
  signal: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const blocks: StreamBlock[] = [];
  const toolIndexes = new Map<string, number>();
  let usage: TokenUsage | undefined;
  let finish: string | undefined;
  let active = -1;
  for await (const event of sseJson(response, signal)) {
    signal.throwIfAborted();
    const packet = wireResponse(event);
    if (isRecord(packet.usageMetadata)) usage = tokenUsage(packet.usageMetadata);
    if (packet.candidates !== undefined && !Array.isArray(packet.candidates))
      throw new LlmError('Antigravity returned invalid candidates.', 'MALFORMED_RESPONSE');
    const candidate: unknown = Array.isArray(packet.candidates) ? packet.candidates[0] : undefined;
    if (candidate !== undefined && !isRecord(candidate))
      throw new LlmError('Antigravity returned an invalid candidate.', 'MALFORMED_RESPONSE');
    if (isRecord(candidate)) {
      if (typeof candidate.finishReason === 'string') finish = candidate.finishReason;
      const content = isRecord(candidate.content) ? candidate.content : undefined;
      const parts = content?.parts ?? [];
      if (!Array.isArray(parts))
        throw new LlmError('Antigravity returned invalid content parts.', 'MALFORMED_RESPONSE');
      for (const part of parts) {
        if (!isRecord(part))
          throw new LlmError('Antigravity returned an invalid content part.', 'MALFORMED_RESPONSE');
        if (isRecord(part.functionCall)) {
          const call = part.functionCall;
          if (typeof call.name !== 'string' || !call.name)
            throw new LlmError(
              'Antigravity returned a tool call without a name.',
              'MALFORMED_RESPONSE',
            );
          const id = typeof call.id === 'string' && call.id ? call.id : `call_${randomUUID()}`;
          const args =
            call.args === undefined
              ? {}
              : typeof call.args === 'string'
                ? parseArguments(call.args)
                : call.args;
          if (!isRecord(args))
            throw new LlmError(
              'Antigravity returned invalid tool arguments.',
              'MALFORMED_RESPONSE',
            );
          let index = toolIndexes.get(id);
          if (index === undefined) {
            index = blocks.length;
            toolIndexes.set(id, index);
            blocks.push({
              block: {
                type: 'tool-call',
                id: ToolCallId(id),
                name: call.name,
                arguments: JSON.stringify(args),
              },
            });
            yield { type: 'block-start', index, blockType: 'tool-call' };
          } else {
            const existing = blocks[index].block;
            if (existing.type !== 'tool-call' || existing.name !== call.name)
              throw new LlmError('Antigravity changed a tool call identity.', 'MALFORMED_RESPONSE');
            existing.arguments = JSON.stringify(args);
          }
          active = index;
        } else if (typeof part.text === 'string') {
          const type = part.thought === true ? 'reasoning' : 'text';
          if (active < 0 || blocks[active].block.type !== type) {
            active = blocks.length;
            blocks.push({ block: { type, text: '' } });
            yield { type: 'block-start', index: active, blockType: type };
          }
          const block = blocks[active].block;
          if (block.type === 'text' || block.type === 'reasoning') {
            const delta = part.text;
            block.text += delta;
            if (delta)
              yield {
                type: type === 'text' ? 'text-delta' : 'reasoning-delta',
                index: active,
                text: delta,
              };
          }
        } else if (!('thoughtSignature' in part)) {
          throw new LlmError(
            'Antigravity returned an unsupported response part.',
            'UNSUPPORTED_CONTENT',
          );
        }
        if (typeof part.thoughtSignature === 'string' && active >= 0)
          blocks[active].signature = part.thoughtSignature;
      }
    }
    if (finish && usage) break;
  }
  signal.throwIfAborted();
  if (!finish)
    throw new LlmError(
      'Antigravity closed its stream before completing the response.',
      'STREAM_CLOSED',
    );
  if (!['STOP', 'MAX_TOKENS'].includes(finish))
    throw new LlmError(
      'Antigravity did not complete this request.',
      /SAFETY|RECITATION|PROHIBITED|BLOCK|SPII/.test(finish)
        ? 'CONTENT_REFUSED'
        : 'MALFORMED_RESPONSE',
    );
  if (
    !blocks.some(
      ({ block }) =>
        block.type === 'tool-call' ||
        ((block.type === 'text' || block.type === 'reasoning') && block.text),
    )
  )
    throw new LlmError('Antigravity returned an empty response.', 'EMPTY_RESPONSE');
  for (const [index, item] of blocks.entries()) {
    if (item.block.type === 'tool-call')
      yield {
        type: 'tool-call-delta',
        index,
        id: item.block.id,
        name: item.block.name,
        argumentsDelta: item.block.arguments,
      };
    yield { type: 'block-end', index, block: item.block };
  }
  if (usage) yield { type: 'usage', usage };
  const replayState: ReplayEnvelope = {
    response: { kind: 'dsh-antigravity', version: 1, provider: 'antigravity', model: model.id },
    blocks: blocks.map((item) => ({
      type: item.block.type,
      ...(item.signature ? { thoughtSignature: item.signature } : {}),
    })),
  };
  yield {
    type: 'finish',
    reason: {
      kind: finish === 'MAX_TOKENS' ? 'max-tokens' : toolIndexes.size ? 'tool-calls' : 'stop',
    },
    replayState,
  };
}
