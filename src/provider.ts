import type { Context } from '@deepseek-ai/cordis';
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { fetchAvailableModelsCatalog, parseApiKey, postRpc } from './client.js';
import { conversationChunks, conversationRequest, imageTarget } from './conversation.js';
import {
  buildCatalog,
  fallbackCatalog,
  modelInfo,
  resolveDefinition,
  type ModelCatalog,
} from './models.js';
import type { Auth } from './auth.js';
export { PROVIDER } from './models.js';

const CATALOG_TTL = 4 * 60 * 60 * 1000;
export interface Backend {
  discover: typeof fetchAvailableModelsCatalog;
  post: typeof postRpc;
}
const backend: Backend = { discover: fetchAvailableModelsCatalog, post: postRpc };
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

/** Native DSH provider; credential and model state are private to this instance. */
export class AntigravityAdapter extends LlmAdapter {
  private catalog: ModelCatalog = fallbackCatalog();
  private credential?: string;
  private nextRefresh = 0;
  private generation = 0;
  constructor(
    private readonly ctx: Context,
    private readonly auth: Auth,
    private readonly remote: Backend = backend,
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
  private assertCurrent(generation: number): void {
    if (generation !== this.generation)
      throw new LlmError(
        'Antigravity credentials changed during model discovery. Retry the request.',
        'AUTH',
      );
  }
  private async loadCatalog(
    apiKey: string,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const { token, projectId } = parseApiKey(apiKey);
    const identity = `${accountId}:${projectId}`;
    if (this.credential === identity && Date.now() < this.nextRefresh) return;
    if (this.credential !== identity) {
      this.invalidate();
      this.credential = identity;
      this.catalog = fallbackCatalog();
    }
    const generation = this.generation;
    try {
      const discovered = await withCancellation(
        this.remote.discover(token, projectId, signal),
        signal,
      );
      signal?.throwIfAborted();
      this.assertCurrent(generation);
      this.catalog = buildCatalog(discovered.data.models, discovered.data.agentModelSorts);
      this.nextRefresh = Date.now() + CATALOG_TTL;
    } catch (error) {
      signal?.throwIfAborted();
      this.assertCurrent(generation);
      if (error instanceof LlmError && error.code === 'AUTH') {
        this.invalidate();
        this.catalog = new Map();
        throw error;
      }
      this.nextRefresh = Date.now() + 30000;
      this.ctx.logger.warn(
        'Antigravity model discovery failed; retaining the previous catalog for this account.',
      );
    }
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
    return [...this.catalog.values()].map(modelInfo);
  }
  override async resolveModel(
    _provider: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted();
    const session = await withCancellation(this.auth.getSession(), signal);
    await this.loadCatalog(session.apiKey, session.accountId, signal);
    return modelInfo(resolveDefinition(this.catalog, id));
  }
  override imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef) {
    return imageTarget(image);
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
      const model = resolveDefinition(this.catalog, options.model);
      const { token, projectId } = parseApiKey(apiKey);
      const request = await conversationRequest(options, model, projectId, this.ctx, signal, () =>
        this.ctx.logger.warn(
          'Antigravity: incompatible replay metadata; preserving visible history without foreign signatures.',
        ),
      );
      signal.throwIfAborted();
      const response = await this.remote.post('streamGenerateContent', request, token, signal, {
        stream: true,
      });
      yield* conversationChunks(response, model, signal);
    } finally {
      consumer.abort();
    }
  }
}
