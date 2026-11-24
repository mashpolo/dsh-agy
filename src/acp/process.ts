import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';

// Package self-reference works from both src/acp/process.ts and the bundled dist/index.js.
const { version: clientVersion }: { version: string } = createRequire(import.meta.url)(
  'dsh-antigravity/package.json',
);

export interface AcpProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onUpdate: (update: Record<string, unknown>) => void;
  onPermission: (request: Record<string, unknown>) => Promise<string | null>;
  onExit: () => void;
}

type RpcId = string | number;
type Model = { id: string; name: string };
type SessionModels = { models: Model[]; currentModel?: string };
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};
type Turn = { cancelled: boolean; timer?: NodeJS.Timeout };
type Permission = { turn: Turn; sessionId: string };

const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const CANCEL_TIMEOUT_MS = 2_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function rpcId(value: unknown): value is RpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}
function choices(options: unknown): Model[] {
  if (!Array.isArray(options)) return [];
  const values: Model[] = [];
  for (const option of options) {
    if (!record(option)) continue;
    if (Array.isArray(option.options)) values.push(...choices(option.options));
    else if (typeof option.value === 'string' && option.value) {
      values.push({
        id: option.value,
        name: typeof option.name === 'string' ? option.name : option.value,
      });
    }
  }
  return [...new Map(values.map((value) => [value.id, value])).values()];
}
function configOption(value: unknown, category: string): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find(
    (option): option is Record<string, unknown> =>
      record(option) &&
      option.type === 'select' &&
      (option.category === category || option.id === category || option.configId === category),
  );
}
function configId(option: Record<string, unknown>): string | undefined {
  const value = option.id ?? option.configId;
  return typeof value === 'string' && value ? value : undefined;
}

/** A single isolated ACP session over a child process's NDJSON stdin/stdout. */
export class AcpProcess {
  private child?: ChildProcessWithoutNullStreams;
  private state: 'idle' | 'starting' | 'ready' | 'closing' | 'closed' = 'idle';
  private startPromise?: Promise<SessionModels>;
  private sessionId?: string;
  private nextId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly permissions = new Map<RpcId, Permission>();
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private turn?: Turn;
  private changingModel = false;
  private models: Model[] = [];
  private currentModel?: string;
  private modelConfigId?: string;
  private legacyModels = false;
  private killTimer?: NodeJS.Timeout;
  private notifiedExit = false;

  constructor(private readonly options: AcpProcessOptions) {}

  start(): Promise<SessionModels> {
    if (this.state === 'closing' || this.state === 'closed')
      return Promise.reject(new Error('ACP process is closed.'));
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'idle') return Promise.reject(new Error('ACP process is closed.'));
    this.startPromise = this.initialize();
    return this.startPromise;
  }

  private async initialize(): Promise<SessionModels> {
    this.state = 'starting';
    try {
      if (!this.options.env.GEMINI_API_KEY?.trim()) {
        throw new Error('Set GEMINI_API_KEY before starting the Antigravity ACP session.');
      }
      this.child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: 'pipe',
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const child = this.child;
      child.stdout.on('data', (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
      child.stdout.on('end', () => {
        this.receive(this.decoder.end());
        if (this.buffer.trim()) {
          const final = this.buffer;
          this.buffer = '';
          this.receive(final + '\n');
        }
      });
      // Drain diagnostics, but never retain or propagate CLI output that may contain credentials.
      child.stderr.resume();
      child.stdin.on('error', () => this.stop(new Error('ACP input stream closed.')));
      child.stdout.on('error', () => this.stop(new Error('ACP output stream closed.')));
      child.once('error', () => this.stop(new Error('Could not start the ACP process.')));
      child.once('close', () => this.finished(new Error('ACP process exited.')));

      const initialized = await this.request('initialize', {
        protocolVersion: 2,
        clientCapabilities: {},
        clientInfo: {
          name: 'dsh-antigravity',
          title: 'DeepSeek Harness Antigravity',
          version: clientVersion,
        },
      });
      if (
        !record(initialized) ||
        typeof initialized.protocolVersion !== 'number' ||
        ![1, 2].includes(initialized.protocolVersion)
      ) {
        throw new Error('The ACP agent returned an unsupported protocol version.');
      }
      // Antigravity accepts this explicit method even when it omits it from authMethods.
      // Never try personal OAuth or rely on the CLI's previously selected account.
      await this.request('authenticate', { methodId: 'gemini-api-key' });
      const session = await this.request('session/new', { cwd: this.options.cwd, mcpServers: [] });
      if (!record(session) || typeof session.sessionId !== 'string' || !session.sessionId) {
        throw new Error('The ACP agent returned an invalid session.');
      }
      this.sessionId = session.sessionId;
      this.readModels(session);
      await this.selectApprovalMode(session);
      this.state = 'ready';
      return this.snapshot();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('ACP initialization failed.');
      this.stop(failure);
      throw failure;
    }
  }

  private snapshot(): SessionModels {
    return {
      models: this.models.map((model) => ({ ...model })),
      ...(this.currentModel ? { currentModel: this.currentModel } : {}),
    };
  }

  private readModels(value: Record<string, unknown>): void {
    const option = configOption(value.configOptions, 'model');
    if (option && configId(option)) {
      this.modelConfigId = configId(option);
      this.legacyModels = false;
      this.models = choices(option.options);
      this.currentModel = typeof option.currentValue === 'string' ? option.currentValue : undefined;
    } else if (record(value.models) && Array.isArray(value.models.availableModels)) {
      this.modelConfigId = undefined;
      this.legacyModels = true;
      this.models = value.models.availableModels.flatMap((model) =>
        record(model) && typeof model.modelId === 'string'
          ? [
              {
                id: model.modelId,
                name: typeof model.name === 'string' ? model.name : model.modelId,
              },
            ]
          : [],
      );
      this.currentModel =
        typeof value.models.currentModelId === 'string' ? value.models.currentModelId : undefined;
    } else if (Array.isArray(value.configOptions)) {
      this.models = [];
      this.currentModel = undefined;
      this.modelConfigId = undefined;
      this.legacyModels = false;
    }
  }

  private async selectApprovalMode(session: Record<string, unknown>): Promise<void> {
    const option = configOption(session.configOptions, 'mode');
    const modes = record(session.modes) ? session.modes : undefined;
    const available = option
      ? choices(option.options)
      : Array.isArray(modes?.availableModes)
        ? modes.availableModes.flatMap((mode) =>
            record(mode) && typeof mode.id === 'string'
              ? [{ id: mode.id, name: String(mode.name ?? mode.id) }]
              : [],
          )
        : [];
    const safe = ['default', 'approval-required', 'ask'].find((id) =>
      available.some((mode) => mode.id === id),
    );
    if (!safe) {
      const current = option?.currentValue ?? modes?.currentModeId;
      if (typeof current === 'string' && /^(?:auto[_-]?edit|yolo)$/i.test(current)) {
        throw new Error(
          'The ACP agent is in an unsafe mode and offers no approval-required alternative.',
        );
      }
      // Without an advertised mode, preserve the CLI's startup policy. The launcher
      // uses a fresh profile and sandbox; do not invent an unsupported mode option.
      return;
    }
    if (option) {
      const id = configId(option);
      if (!id) throw new Error('The ACP agent returned an invalid session mode option.');
      const result = await this.request('session/set_config_option', {
        sessionId: this.sessionId,
        configId: id,
        value: safe,
      });
      if (record(result)) this.readModels(result);
    } else await this.request('session/set_mode', { sessionId: this.sessionId, modeId: safe });
  }

  async setModel(id: string): Promise<void> {
    this.assertReady();
    if (this.turn || this.changingModel) throw new Error('An ACP operation is already active.');
    if (id === this.currentModel) return;
    if (!this.models.some((model) => model.id === id))
      throw new Error('The requested model is not offered by the ACP agent.');
    if (!this.modelConfigId && !this.legacyModels)
      throw new Error('The ACP agent does not support model selection.');
    this.changingModel = true;
    try {
      const result = this.modelConfigId
        ? await this.request('session/set_config_option', {
            sessionId: this.sessionId,
            configId: this.modelConfigId,
            value: id,
          })
        : await this.request('session/set_model', { sessionId: this.sessionId, modelId: id });
      this.currentModel = id;
      if (record(result)) this.readModels(result);
    } finally {
      this.changingModel = false;
    }
  }

  async prompt(text: string): Promise<string> {
    this.assertReady();
    if (this.turn || this.changingModel) throw new Error('An ACP operation is already active.');
    if (!text.trim()) throw new Error('An ACP prompt must not be empty.');
    const turn: Turn = { cancelled: false };
    this.turn = turn;
    try {
      const result = await this.request(
        'session/prompt',
        { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
        false,
      );
      if (!record(result) || typeof result.stopReason !== 'string') {
        const error = new Error('The ACP agent returned an invalid prompt result.');
        this.stop(error);
        throw error;
      }
      return turn.cancelled ? 'cancelled' : result.stopReason;
    } finally {
      if (turn.timer) clearTimeout(turn.timer);
      this.cancelPermissions(turn);
      if (this.turn === turn) this.turn = undefined;
    }
  }

  cancel(): void {
    const turn = this.turn;
    if (!turn || turn.cancelled || this.state !== 'ready') return;
    turn.cancelled = true;
    this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
    this.cancelPermissions(turn);
    turn.timer = setTimeout(
      () =>
        this.stop(new Error('The ACP agent did not finish cancellation; its process was closed.')),
      CANCEL_TIMEOUT_MS,
    );
    turn.timer.unref();
  }

  close(): void {
    this.cancel();
    this.stop(new Error('ACP process closed.'));
  }

  private assertReady(): void {
    if (this.state !== 'ready' || !this.sessionId) throw new Error('The ACP session is not ready.');
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeout = true,
  ): Promise<unknown> {
    if (this.state === 'closing' || this.state === 'closed')
      return Promise.reject(new Error('ACP process is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeout) {
        pending.timer = setTimeout(
          () => this.stop(new Error(`ACP ${method} timed out.`)),
          REQUEST_TIMEOUT_MS,
        );
        pending.timer.unref();
      }
      this.pending.set(id, pending);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child || this.state === 'closing' || this.state === 'closed') return;
    this.child.stdin.write(JSON.stringify(message) + '\n', (error) => {
      if (error) this.stop(new Error('Could not write to the ACP process.'));
    });
  }

  private receive(text: string): void {
    if (this.state === 'closing' || this.state === 'closed') return;
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      if (line.length > MAX_FRAME_CHARS) {
        this.stop(new Error('The ACP message exceeds the supported size.'));
        return;
      }
      try {
        const value: unknown = JSON.parse(line);
        if (!record(value) || value.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC envelope');
        this.handle(value);
      } catch {
        this.stop(new Error('The ACP process returned malformed JSON-RPC data.'));
        return;
      }
    }
    if (this.buffer.length > MAX_FRAME_CHARS)
      this.stop(new Error('The ACP message exceeds the supported size.'));
  }

  private handle(message: Record<string, unknown>): void {
    if (typeof message.method === 'string') {
      if (rpcId(message.id)) {
        if (message.method === 'session/request_permission')
          this.permission(message.id, message.params);
        else this.replyError(message.id, -32601, 'Client method not supported.');
      } else if ('id' in message) {
        this.send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid client request id.' },
        });
      } else if (message.method === 'session/update') this.update(message.params);
      return;
    }
    if (!rpcId(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (record(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : -32603;
      pending.reject(new Error(`ACP request failed (code ${code}).`));
    } else if ('result' in message) pending.resolve(message.result);
    else pending.reject(new Error('The ACP agent returned an invalid response.'));
  }

  private update(params: unknown): void {
    if (
      !record(params) ||
      !this.sessionId ||
      params.sessionId !== this.sessionId ||
      !record(params.update)
    )
      return;
    const update = params.update;
    if (update.sessionUpdate === 'config_option_update') this.readModels(update);
    if (
      update.sessionUpdate === 'current_model_update' &&
      typeof update.currentModelId === 'string'
    )
      this.currentModel = update.currentModelId;
    const contentUpdate =
      typeof update.sessionUpdate === 'string' &&
      /^(agent_|user_message_|tool_call|plan$)/.test(update.sessionUpdate);
    if (contentUpdate && (!this.turn || this.turn.cancelled)) return;
    try {
      this.options.onUpdate(update);
    } catch {
      /* UI observers do not own the transport. */
    }
  }

  private permission(id: RpcId, params: unknown): void {
    if (
      !record(params) ||
      !this.sessionId ||
      params.sessionId !== this.sessionId ||
      !Array.isArray(params.options)
    ) {
      this.replyError(id, -32602, 'Permission request does not belong to this session.');
      return;
    }
    if (!this.turn || this.turn.cancelled) {
      this.replyPermission(id, null);
      return;
    }
    const allowed = new Set(
      params.options.flatMap((option) =>
        record(option) && typeof option.optionId === 'string' && option.optionId
          ? [option.optionId]
          : [],
      ),
    );
    if (!allowed.size) {
      this.replyError(id, -32602, 'Permission request has no valid options.');
      return;
    }
    if (this.permissions.has(id)) {
      this.stop(new Error('The ACP agent reused an outstanding permission request id.'));
      return;
    }
    const permission: Permission = { turn: this.turn, sessionId: this.sessionId };
    this.permissions.set(id, permission);
    Promise.resolve()
      .then(() =>
        this.permissions.get(id) === permission && !permission.turn.cancelled
          ? this.options.onPermission(params)
          : null,
      )
      .then(
        (choice) => {
          if (this.permissions.get(id) !== permission) return;
          this.permissions.delete(id);
          const current =
            this.turn === permission.turn &&
            !permission.turn.cancelled &&
            this.sessionId === permission.sessionId;
          this.replyPermission(
            id,
            current && typeof choice === 'string' && allowed.has(choice) ? choice : null,
          );
        },
        () => {
          if (this.permissions.get(id) !== permission) return;
          this.permissions.delete(id);
          this.replyPermission(id, null);
        },
      );
  }

  private replyError(id: RpcId, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }
  private replyPermission(id: RpcId, optionId: string | null): void {
    this.send({
      jsonrpc: '2.0',
      id,
      result: {
        outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId },
      },
    });
  }
  private cancelPermissions(turn?: Turn): void {
    for (const [id, permission] of this.permissions) {
      if (turn && permission.turn !== turn) continue;
      this.permissions.delete(id);
      this.replyPermission(id, null);
    }
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  private kill(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* The process may already have exited. */
    }
  }
  private stop(error: Error): void {
    if (this.state === 'closing' || this.state === 'closed') return;
    this.cancelPermissions();
    this.state = 'closing';
    this.buffer = '';
    this.rejectPending(error);
    if (this.turn?.timer) clearTimeout(this.turn.timer);
    if (!this.child) {
      this.finished(error);
      return;
    }
    this.child.stdin.end();
    this.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.kill('SIGKILL'), 1000);
    this.killTimer.unref();
  }
  private finished(error: Error): void {
    this.state = 'closed';
    this.buffer = '';
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.turn?.timer) clearTimeout(this.turn.timer);
    this.permissions.clear();
    this.rejectPending(error);
    if (this.notifiedExit) return;
    this.notifiedExit = true;
    try {
      this.options.onExit();
    } catch {
      /* Exit notification must not leak process resources. */
    }
  }
}
