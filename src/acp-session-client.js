export async function postAcp(body, options = {}) {
  const response = await fetch('api/antigravity/acp', {
    method: 'POST',
    mode: 'same-origin',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...options,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      typeof data?.error === 'string' ? data.error : `ACP 请求失败（HTTP ${response.status}）`,
    );
    error.status = response.status;
    throw error;
  }
  if (!data || typeof data !== 'object') throw new Error('ACP 服务返回了无效的数据');
  return data;
}

const initial = {
  session: null,
  entries: [],
  pending: '',
  running: false,
  stopping: false,
  pollPaused: false,
  expired: false,
  error: '',
};

function append(entries, event) {
  const previous = entries.at(-1);
  if ((event.type === 'text' || event.type === 'thought') && previous?.type === event.type) {
    entries[entries.length - 1] = { ...previous, text: previous.text + (event.text ?? '') };
  } else {
    entries.push(
      event.type === 'done' && event.status === 'cancelled' ? { ...event, text: '已停止' } : event,
    );
  }
}

function expirePermissions(entries) {
  return entries.map((item) =>
    item.type === 'permission' && !item.answered ? { ...item, expired: true } : item,
  );
}

export class AcpSession {
  state = initial;
  listeners = new Set();
  after = 0;
  pollController;
  timer;
  disposed = false;

  constructor(request = postAcp, interval = 400) {
    this.request = request;
    this.interval = interval;
  }

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.state;
  update(change) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  reportFailure(error, action) {
    if (error.status === 410 && action !== 'open') {
      this.stopPolling();
      this.update({
        session: null,
        expired: true,
        running: false,
        stopping: false,
        pollPaused: false,
        entries: expirePermissions(this.state.entries),
        error: '',
      });
      return;
    }
    this.update({
      error: error.message || 'ACP 操作失败',
      ...(action === 'poll' ? { pollPaused: true } : {}),
    });
  }

  // Set pending synchronously before the first await so double clicks cannot start two actions.
  async command(action, operation) {
    if (this.disposed || this.state.pending) return false;
    this.update({ pending: action, error: '' });
    try {
      await operation();
      return true;
    } catch (error) {
      this.reportFailure(error, action);
      return false;
    } finally {
      this.update({ pending: '' });
    }
  }

  open(harnessSessionId) {
    if (this.state.session) return;
    return this.command('open', async () => {
      if (typeof harnessSessionId !== 'string' || !harnessSessionId.trim())
        throw new Error('请先打开已选择工作目录的 Harness 会话，再打开 ACP。');
      const session = await this.request({ action: 'open', harnessSessionId });
      if (!session.id) throw new Error('ACP 服务未返回会话 ID');
      if (this.disposed) {
        await this.request({ action: 'close', id: session.id }, { keepalive: true });
        return;
      }
      this.after = 0;
      this.update({ ...initial, session });
    });
  }

  send(text, model) {
    const id = this.state.session?.id;
    if (!id || this.state.running || !text.trim()) return;
    return this.command('prompt', async () => {
      await this.request({ action: 'prompt', id, text, ...(model ? { model } : {}) });
      this.update({ entries: [...this.state.entries, { type: 'user', text }], running: true });
      this.resume();
    });
  }

  permission(permissionId, optionId) {
    const { session, entries, running, stopping } = this.state;
    const event = entries.findLast(
      (item) => item.type === 'permission' && item.permissionId === permissionId,
    );
    if (!running || stopping || !event || event.answered || event.expired) return;
    return this.command('permission', async () => {
      await this.request({ action: 'permission', id: session.id, permissionId, optionId });
      this.update({
        entries: this.state.entries.map((item) =>
          item === event ? { ...item, answered: true, optionId } : item,
        ),
      });
    });
  }

  cancel() {
    if (!this.state.running || this.state.stopping) return;
    return this.command('cancel', async () => {
      await this.request({ action: 'cancel', id: this.state.session.id });
      if (this.state.running) this.update({ stopping: true });
    });
  }

  close() {
    if (!this.state.session) return;
    return this.command('close', async () => {
      await this.request({ action: 'close', id: this.state.session.id });
      this.stopPolling();
      this.update(initial);
    });
  }

  resume() {
    if (this.disposed || !this.state.running || this.pollController) return;
    const controller = new AbortController();
    this.pollController = controller;
    this.update({ pollPaused: false, error: '' });
    const poll = async () => {
      try {
        const data = await this.request(
          { action: 'poll', id: this.state.session.id, after: this.after },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!Array.isArray(data.events)) throw new Error('ACP 服务未返回事件列表');
        const entries = [...this.state.entries];
        let done = false;
        for (const event of data.events) {
          if (!Number.isSafeInteger(event.seq)) throw new Error('ACP 事件缺少序号');
          if (event.seq <= this.after) continue;
          this.after = event.seq;
          append(entries, event);
          if (event.type === 'done' || event.type === 'error') done = true;
        }
        if (data.events.length)
          this.update({
            entries: done ? expirePermissions(entries) : entries,
            running: !done,
            ...(done ? { stopping: false } : {}),
          });
        if (done) this.stopPolling();
        else if (!controller.signal.aborted) this.timer = setTimeout(poll, this.interval);
      } catch (error) {
        if (controller.signal.aborted) return;
        this.stopPolling();
        this.reportFailure(error, 'poll');
      }
    };
    void poll();
  }

  stopPolling() {
    clearTimeout(this.timer);
    this.pollController?.abort();
    this.pollController = undefined;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPolling();
    this.listeners.clear();
    if (this.state.session)
      void this.request({ action: 'close', id: this.state.session.id }, { keepalive: true }).catch(
        () => {},
      );
  }
}
