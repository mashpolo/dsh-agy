import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AcpSession } from './acp-session-client.js';
import css from './acp-panel.css';

function Entry({ entry, state, manager }) {
  switch (entry.type) {
    case 'user':
    case 'text':
      return (
        <div className={'agy-acp-message agy-acp-' + entry.type}>
          <strong>{entry.type === 'user' ? '你' : 'Antigravity'}</strong>
          <p>{entry.text}</p>
        </div>
      );
    case 'done':
      return entry.text ? (
        <p className="agy-acp-status" role="status">
          {entry.text}
        </p>
      ) : null;
    case 'error':
      return (
        <p className="agy-acp-error" role="alert">
          {entry.text || '当前请求失败'}
        </p>
      );
    case 'permission': {
      const options = entry.options ?? [];
      const label =
        entry.optionId == null
          ? '已取消授权请求'
          : options.find((option) => option.id === entry.optionId)?.label;
      return (
        <section className="agy-acp-permission">
          <strong>{entry.title || '工具请求授权'}</strong>
          {entry.text && <p>{entry.text}</p>}
          {entry.answered || entry.expired ? (
            <small>{entry.answered ? label || '已处理' : '请求已结束'}</small>
          ) : (
            <div className="agy-acp-buttons">
              {options.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  disabled={!!state.pending || state.stopping}
                  onClick={() => manager.permission(entry.permissionId, option.id)}
                >
                  {option.label}
                </button>
              ))}
              <button
                type="button"
                disabled={!!state.pending || state.stopping}
                onClick={() => manager.permission(entry.permissionId, null)}
              >
                取消授权请求
              </button>
            </div>
          )}
        </section>
      );
    }
    default:
      return null;
  }
}

export function AcpPanel({ hostSessionId }) {
  const manager = useRef(null);
  const [state, setState] = useState(null);
  const [visible, setVisible] = useState(false);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('');
  const dialog = useRef(null);
  const history = useRef(null);
  const pinned = useRef(true);
  const id = useId();
  useEffect(() => {
    const reset = () => {
      manager.current?.dispose();
      const session = new AcpSession();
      manager.current = session;
      session.subscribe(() => setState(session.state));
      setState(session.state);
      setVisible(false);
      setDraft('');
      setModel('');
    };
    const unload = () => manager.current?.dispose();
    const restore = (event) => {
      if (event.persisted) reset();
    };
    reset();
    window.addEventListener('pagehide', unload);
    window.addEventListener('pageshow', restore);
    return () => {
      unload();
      window.removeEventListener('pagehide', unload);
      window.removeEventListener('pageshow', restore);
    };
  }, [hostSessionId]);

  useLayoutEffect(() => {
    if (!visible) return;
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, [visible]);

  useLayoutEffect(() => {
    if (visible && pinned.current && history.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [visible, state?.entries]);

  const connect = () => {
    setModel('');
    void manager.current?.open(hostSessionId);
  };
  const open = () => {
    setVisible(true);
    if (!state?.session && !state?.expired) connect();
  };
  const send = async (event) => {
    event.preventDefault();
    pinned.current = true;
    const current = manager.current;
    if (
      (await current.send(draft.trim(), model || state.session.currentModel)) &&
      current === manager.current
    )
      setDraft('');
  };
  const close = async () => {
    if (await manager.current.close()) {
      setDraft('');
      setModel('');
      setVisible(false);
    }
  };
  const session = state?.session;
  const waiting = state?.entries.some(
    (entry) => entry.type === 'permission' && !entry.expired && !entry.answered,
  );
  const models = session?.models ?? [];
  const pending = !!state?.pending;
  return (
    <>
      <style>{css}</style>
      <button
        type="button"
        className="agy-acp-trigger"
        aria-haspopup="dialog"
        aria-expanded={visible}
        aria-controls={visible ? id : undefined}
        disabled={!state}
        title="打开 Antigravity 会话"
        onClick={open}
      >
        Antigravity{state?.running ? (waiting ? ' · 待授权' : ' · 运行中') : ''}
      </button>
      {visible && (
        <dialog
          ref={dialog}
          id={id}
          className="agy-acp"
          aria-labelledby={id + '-title'}
          onCancel={(event) => {
            event.preventDefault();
            setVisible(false);
          }}
        >
          <header>
            <h2 id={id + '-title'}>Antigravity</h2>
            <div className="agy-acp-buttons">
              {session && (
                <button type="button" disabled={pending} onClick={close}>
                  结束会话
                </button>
              )}
              <button type="button" onClick={() => setVisible(false)}>
                隐藏
              </button>
            </div>
          </header>
          {models.length > 0 && (
            <div className="agy-acp-context">
              <label>
                模型{' '}
                <select
                  value={model || session.currentModel || ''}
                  disabled={pending || state.running}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {!session.currentModel && <option value="">CLI 默认</option>}
                  {models.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name || item.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div
            className="agy-acp-history"
            ref={history}
            onScroll={(event) => {
              const el = event.currentTarget;
              pinned.current = el.scrollHeight - el.clientHeight - el.scrollTop < 80;
            }}
          >
            {!session && state.pending === 'open' && <p role="status">正在连接 Antigravity…</p>}
            {state.entries.map((entry, index) => (
              <Entry key={index} entry={entry} state={state} manager={manager.current} />
            ))}
            {session && !state.entries.length && (
              <p className="agy-acp-empty">已连接。发送消息以开始对话。</p>
            )}
          </div>
          {(state.error || state.pollPaused || state.expired) && (
            <div className="agy-acp-feedback" role="alert">
              <span>
                {state.error ||
                  (state.expired ? '会话已失效。可查看本次记录，或开始新会话。' : '接收已暂停')}
              </span>
              {!session && (
                <button type="button" disabled={pending} onClick={connect}>
                  {state.expired ? '开始新会话' : '重新连接'}
                </button>
              )}
              {state.pollPaused && (
                <button type="button" disabled={pending} onClick={() => manager.current.resume()}>
                  恢复接收
                </button>
              )}
            </div>
          )}
          {session && (
            <form onSubmit={send}>
              <textarea
                rows={2}
                aria-label="发给 Antigravity 的消息"
                placeholder="发给 Antigravity…"
                value={draft}
                disabled={state.pending === 'prompt'}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(event) => {
                  if (
                    !event.nativeEvent.isComposing &&
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    event.currentTarget.form.requestSubmit();
                  }
                }}
              />
              <div className="agy-acp-send">
                <span role="status">
                  {state.running
                    ? state.pollPaused
                      ? '接收已暂停'
                      : state.stopping
                        ? '正在停止…'
                        : waiting
                          ? '等待授权'
                          : '正在运行…'
                    : ''}
                </span>
                {state.running ? (
                  <button
                    type="button"
                    disabled={pending || state.stopping}
                    onClick={() => manager.current.cancel()}
                  >
                    停止本轮
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="agy-acp-primary"
                    disabled={pending || !draft.trim()}
                  >
                    发送
                  </button>
                )}
              </div>
            </form>
          )}
        </dialog>
      )}
    </>
  );
}
