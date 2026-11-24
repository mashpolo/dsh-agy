import { randomUUID } from 'node:crypto';
import { AcpProcess, record as isRecord } from './process.js';

class InputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface PanelEvent {
  type: 'text' | 'permission' | 'done' | 'error';
  title?: string;
  text?: string;
  status?: string;
  permissionId?: string;
  options?: { id: string; label: string }[];
}
function describeTool(tool: Record<string, unknown>) {
  const title = typeof tool.title === 'string' ? tool.title : '原生工具';
  const details = tool.rawInput ?? tool.locations;
  return { title, ...(details == null ? {} : { text: JSON.stringify(details, null, 2) }) };
}

class PanelConversation {
  readonly process: AcpProcess;
  readonly permissions = new Map<
    string,
    { options: Set<string>; resolve: (answer: string | null) => void }
  >();
  events: (PanelEvent & { seq: number })[] = [];
  sequence = 0;
  private turn?: { cancelled: boolean };
  private retainedBytes = 0;
  lastSeen = Date.now();
  closed = false;
  constructor(command: string, args: string[], cwd: string) {
    this.process = new AcpProcess({
      command,
      args,
      cwd,
      onUpdate: (update) => {
        if (
          update.sessionUpdate === 'agent_message_chunk' &&
          isRecord(update.content) &&
          update.content.type === 'text' &&
          typeof update.content.text === 'string'
        ) {
          this.emit({ type: 'text', text: update.content.text });
        }
      },
      onPermission: (request) => this.ask(request),
      onExit: () => {
        this.closed = true;
        this.clearPermissions();
      },
    });
  }
  private emit(event: PanelEvent) {
    this.retainedBytes += Buffer.byteLength(JSON.stringify(event));
    if (this.retainedBytes > 8 * 1024 * 1024 || this.events.length >= 32000) {
      this.events = [];
      this.retainedBytes = 0;
      this.events.push({
        seq: ++this.sequence,
        type: 'error',
        text: '未读取的输出过多，ACP 会话已结束。',
      });
      this.close();
      return;
    }
    this.events.push({ ...event, seq: ++this.sequence });
  }
  poll(after: number) {
    // The browser advances the cursor only after it receives and displays a batch.
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence)
      throw new InputError('事件游标无效。');
    let n = 0;
    while (n < this.events.length && this.events[n].seq <= after) n++;
    if (n) {
      this.events.splice(0, n);
      this.retainedBytes = this.events.reduce(
        (count, item) => count + Buffer.byteLength(JSON.stringify(item)),
        0,
      );
    }
    return { events: this.events.slice(0, 512) };
  }
  private ask(request: Record<string, unknown>) {
    if (!this.turn || this.turn.cancelled || !Array.isArray(request.options))
      return Promise.resolve(null);
    const options = request.options
      .filter(isRecord)
      .flatMap((o) =>
        typeof o.optionId === 'string' && typeof o.name === 'string'
          ? [{ id: o.optionId, label: o.name }]
          : [],
      );
    if (!options.length) return Promise.resolve(null);
    const permissionId = randomUUID(),
      answer = Promise.withResolvers<string | null>();
    this.permissions.set(permissionId, {
      options: new Set(options.map((o) => o.id)),
      resolve: answer.resolve,
    });
    this.emit({
      type: 'permission',
      permissionId,
      options,
      ...describeTool(isRecord(request.toolCall) ? request.toolCall : {}),
    });
    return answer.promise;
  }
  answer(id: unknown, option: unknown) {
    const pending = typeof id === 'string' ? this.permissions.get(id) : undefined;
    if (
      !pending ||
      (option !== null && (typeof option !== 'string' || !pending.options.has(option)))
    )
      throw new InputError('审批已结束，或所选操作无效。', 409);
    this.permissions.delete(id as string);
    pending.resolve(option);
  }
  private clearPermissions() {
    for (const request of this.permissions.values()) request.resolve(null);
    this.permissions.clear();
  }
  send(text: string, model?: string) {
    if (this.closed) throw new InputError('ACP 进程已退出，请重新打开会话。', 410);
    if (this.turn) throw new InputError('请等待当前回合结束。', 409);
    const turn = { cancelled: false };
    this.turn = turn;
    void (async () => {
      try {
        if (model) await this.process.setModel(model);
        const status = turn.cancelled ? 'cancelled' : await this.process.prompt(text);
        this.emit({ type: 'done', status });
      } catch (error) {
        this.emit({
          type: 'error',
          text: error instanceof Error ? error.message : 'ACP 会话失败。',
        });
      } finally {
        this.clearPermissions();
        this.turn = undefined;
      }
    })();
  }
  cancel() {
    if (this.turn) this.turn.cancelled = true;
    this.process.cancel();
    this.clearPermissions();
  }
  close() {
    this.cancel();
    this.process.close();
    this.closed = true;
  }
}

export class AcpEndpoint {
  private readonly sessions = new Map<string, PanelConversation>();
  private opening = 0;
  private disposed = false;
  private readonly sweep = setInterval(() => {
    for (const [id, session] of this.sessions) {
      if (Date.now() - session.lastSeen > 30 * 60_000) {
        this.sessions.delete(id);
        session.close();
      }
    }
  }, 60_000).unref();

  constructor(
    private readonly workspace: (id: string, signal: AbortSignal) => Promise<string>,
    private readonly command: string,
    private readonly args: string[] = ['acp', '--sandbox'],
  ) {}
  dispose() {
    this.disposed = true;
    clearInterval(this.sweep);
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
  private async open(hostId: unknown, signal: AbortSignal) {
    if (typeof hostId !== 'string' || !hostId)
      throw new InputError('请先打开一个 Harness 项目会话。');
    if (this.sessions.size + this.opening >= 8)
      throw new InputError('请先关闭不再使用的 ACP 会话。', 429);
    this.opening++;
    try {
      const cwd = await this.workspace(hostId, signal);
      const session = new PanelConversation(this.command, this.args, cwd),
        id = randomUUID();
      const abort = () => session.close();
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        if (this.disposed) throw new InputError('插件已关闭。', 410);
        this.sessions.set(id, session);
        const models = await session.process.start();
        signal.throwIfAborted();
        return { id, cwd, ...models };
      } catch (e) {
        this.sessions.delete(id);
        session.close();
        throw e;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    } finally {
      this.opening--;
    }
  }
  async fetch(request: Request) {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      if (this.disposed) throw new InputError('插件已关闭。', 410);
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
        throw new InputError('请求必须使用 JSON。', 415);
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body)) throw new InputError('请求格式无效。');
      if (body.action === 'open')
        return Response.json(await this.open(body.harnessSessionId, request.signal), { headers });
      const session = typeof body.id === 'string' ? this.sessions.get(body.id) : undefined;
      if (!session) throw new InputError('ACP 会话已结束，请重新打开。', 410);
      session.lastSeen = Date.now();
      switch (body.action) {
        case 'poll':
          return Response.json(session.poll(typeof body.after === 'number' ? body.after : -1), {
            headers,
          });
        case 'prompt':
          if (
            typeof body.text !== 'string' ||
            !body.text.trim() ||
            body.text.length > 128000 ||
            (body.model !== undefined && typeof body.model !== 'string')
          )
            throw new InputError('消息或模型无效（消息最多 128000 个字符）。');
          session.send(body.text, body.model);
          break;
        case 'permission':
          session.answer(body.permissionId, body.optionId);
          break;
        case 'cancel':
          session.cancel();
          break;
        case 'close':
          this.sessions.delete(body.id as string);
          session.close();
          break;
        default:
          throw new InputError('未知的 ACP 操作。');
      }
      return Response.json({ ok: true }, { headers });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'ACP 请求失败。' },
        { status: error instanceof InputError ? error.status : 502, headers },
      );
    }
  }
}
