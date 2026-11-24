import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-fs';
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveImageAttachmentAccess,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { toPiContext, requestImageTarget } from '@deepseek-ai/dsh-llm-pi-ai/src/context.ts';
import { toStreamChunks } from '@deepseek-ai/dsh-llm-pi-ai/src/stream.ts';
import {
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
} from '@deepseek-ai/dsh-llm-pi-ai/src/config.ts';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { Model } from '@earendil-works/pi-ai';
import { DEFAULT_ENDPOINT, parseApiKey } from 'pi-antigravity/src/client/client.js';
import { discoverAntigravityModels } from 'pi-antigravity/src/models/discovery.js';
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
} from 'pi-antigravity/src/models/models.js';
import type { AntigravityCatalog } from 'pi-antigravity/src/models/grouping.js';
import { ANTIGRAVITY_API, streamAntigravity } from 'pi-antigravity/src/stream/stream.js';
import { ThinkingEffort } from 'pi-antigravity/src/types/enums.js';
import type { AntigravityModelConfig } from 'pi-antigravity/src/types/types.js';
import { redactSecrets } from 'pi-antigravity/src/utils/security.js';
import type { Auth } from './auth.js';

export const PROVIDER = 'antigravity';
const CATALOG_TTL = 4 * 60 * 60 * 1000;
const IMAGE_POLICY = {
  maxPixels: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  maxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
};

// Only the external operations are replaceable; message conversion always uses DSH's real implementation.
export interface Backend {
  discover: typeof discoverAntigravityModels;
  stream: typeof streamAntigravity;
  applyCatalog: typeof applyAntigravityCatalog;
}
const backend: Backend = {
  discover: discoverAntigravityModels,
  stream: streamAntigravity,
  applyCatalog: applyAntigravityCatalog,
};

async function withCancellation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function efforts(model: AntigravityModelConfig): ThinkingEffort[] {
  if (!model.reasoning) return [ThinkingEffort.Off];
  return Object.values(ThinkingEffort).filter((level) => model.thinkingLevelMap?.[level] !== null);
}

function modelInfo(model: AntigravityModelConfig): LlmResolvedModelInfo {
  const levels = efforts(model);
  return {
    provider: PROVIDER,
    id: model.id,
    name: model.name,
    inputModalities: [...model.input],
    context: { contextWindow: model.contextWindow },
    defaultMaxTokens: model.maxTokens,
    reasoning: {
      efforts: levels.map((level) => ({ id: ReasoningEffortId(level), name: level })),
      defaultEffort: ReasoningEffortId(levels[0] ?? 'off'),
    },
  };
}

/** One provider route and one DSH credential store. Upstream protocol code is bundled at build time. */
export class AntigravityAdapter extends LlmAdapter {
  private catalog: AntigravityCatalog = {
    models: ANTIGRAVITY_MODELS,
    routing: ANTIGRAVITY_ROUTING,
  };
  private credential?: string;
  private nextRefresh = 0;
  private generation = 0;

  constructor(
    private readonly ctx: Context,
    private readonly auth: Auth,
    private readonly upstream: Backend = backend,
  ) {
    super();
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Antigravity' };
  }

  invalidate(): void {
    this.generation++;
    this.nextRefresh = 0;
  }

  private async loadCatalog(
    apiKey: string,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const identity = `${accountId}:${parseApiKey(apiKey).projectId}`;
    if (this.credential === identity && Date.now() < this.nextRefresh) return;
    if (this.credential !== identity) {
      this.invalidate();
      this.credential = identity;
      this.catalog = { models: ANTIGRAVITY_MODELS, routing: ANTIGRAVITY_ROUTING };
    }
    const generation = this.generation;
    try {
      const discovered = await this.upstream.discover(apiKey, signal);
      signal?.throwIfAborted();
      this.assertCurrent(generation);
      this.catalog = discovered;
      this.nextRefresh = Date.now() + CATALOG_TTL;
    } catch (error) {
      signal?.throwIfAborted();
      this.assertCurrent(generation);
      // Retain the last good directory for the same credential; retry a failed lookup after 30 seconds.
      this.nextRefresh = Date.now() + 30_000;
      this.ctx.logger.warn(
        `Antigravity model discovery failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }
    this.upstream.applyCatalog(this.catalog);
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation)
      throw new LlmError(
        'Antigravity credentials changed during model discovery. Retry the request.',
        'AUTH',
      );
  }

  private model(id: string): AntigravityModelConfig {
    const model = this.catalog.models.find((model) => model.id === id);
    if (!model)
      throw new LlmError(
        `Antigravity model "${id}" is unavailable. Refresh the model list and choose an available model.`,
        'INVALID_REQUEST',
      );
    return model;
  }

  override async listModels(_provider: string): Promise<LlmModelInfo[]> {
    let session: Awaited<ReturnType<Auth['getSession']>>;
    try {
      session = await this.auth.getSession();
    } catch (error) {
      if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return [];
      throw error;
    }
    await this.loadCatalog(session.apiKey, session.accountId);
    return this.catalog.models.map(modelInfo);
  }

  override async resolveModel(
    _provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted();
    const session = await withCancellation(this.auth.getSession(), signal);
    await this.loadCatalog(session.apiKey, session.accountId, signal);
    return modelInfo(this.model(model));
  }

  override imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef) {
    return requestImageTarget(image, IMAGE_POLICY);
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    options.signal?.throwIfAborted();
    if (options.stop?.length)
      throw new LlmError('Antigravity does not support custom stop sequences.', 'INVALID_REQUEST');
    const consumer = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, consumer.signal])
      : consumer.signal;
    try {
      const { apiKey, accountId } = await withCancellation(this.auth.getSession(), signal);
      await this.loadCatalog(apiKey, accountId, signal);
      const definition = this.model(options.model);
      const level = options.reasoningEffort ?? efforts(definition)[0] ?? ThinkingEffort.Off;
      const reasoning = efforts(definition).find((value) => value === level);
      if (reasoning === undefined)
        throw new LlmError(
          `Unsupported reasoning effort "${level}" for ${definition.id}.`,
          'INVALID_REQUEST',
        );
      const { compat: _compat, ...modelConfig } = definition;
      const model: Model<typeof ANTIGRAVITY_API> = {
        ...modelConfig,
        provider: PROVIDER,
        api: ANTIGRAVITY_API,
        baseUrl: DEFAULT_ENDPOINT,
      };
      const attachments = this.ctx.get('attachments');
      const request = { ...options, signal };
      const onReplayDegrade = () =>
        this.ctx.logger.warn(
          'Antigravity: a previous message has incompatible replay data; sending its visible content.',
        );
      const context =
        attachments === undefined
          ? toPiContext(request, undefined, onReplayDegrade)
          : await toPiContext(
              request,
              {
                attachments,
                resolveImageAccess: (ref) =>
                  resolveImageAttachmentAccess(
                    attachments,
                    (path) => this.ctx.get('fs')?.processPathFromHostPath(path),
                    ref,
                  ),
                requestImagePolicy: IMAGE_POLICY,
              },
              onReplayDegrade,
            );
      signal.throwIfAborted();
      const events = this.upstream.stream(model, context, {
        apiKey,
        signal,
        reasoning,
        temperature: options.temperature,
        maxTokens: options.maxTokens ?? model.maxTokens,
        sessionId: options.sessionId,
      });
      yield* toStreamChunks(events, model.contextWindow, signal, model.id);
    } finally {
      consumer.abort();
    }
  }
}
