import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import css from './quota.css';

function Icon({ name, ...props }) {
  const paths = {
    refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 17.9 17',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}

function resetTime(resetAt, now) {
  if (resetAt === null) return '—';
  const minutes = Math.ceil((resetAt - now) / 60000);
  if (minutes <= 0) return '待重置';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return `${hours}h${remainder ? ` ${remainder}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

function QuotaRow({ row, now }) {
  const percent = row.fraction === null ? null : Math.min(1, Math.max(0, row.fraction)) * 100;
  const percentage =
    percent === null
      ? '—'
      : percent > 0 && percent < 0.01
        ? '<0.01%'
        : percent < 100 && percent > 99.99
          ? '>99.99%'
          : `${Number(percent.toFixed(2))}%`;
  const exactReset =
    row.resetAt === null
      ? undefined
      : new Date(row.resetAt).toLocaleString('zh-CN', { hour12: false });
  return (
    <div className="agq-row">
      <span className="agq-model" title={row.label}>
        {row.shortLabel || row.label}
      </span>
      <div
        className={`agq-track${percent === null ? ' agq-unknown' : ''}`}
        role="progressbar"
        aria-label={`${row.label} 剩余额度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? '额度未知' : percentage}
      >
        {percent !== null && <div className="agq-fill" style={{ width: `${percent}%` }} />}
      </div>
      <span className={`agq-percent${percent === 0 ? ' agq-empty' : ''}`}>{percentage}</span>
      <span className="agq-reset" title={exactReset ? `重置时间：${exactReset}` : '重置时间未知'}>
        {resetTime(row.resetAt, now)}
      </span>
    </div>
  );
}

function Loading() {
  return (
    <div className="agq-loading" role="status" aria-live="polite">
      <span className="agq-sr-only">正在读取账户额度</span>
      {[0, 1, 2, 3].map((index) => (
        <div className="agq-skeleton-row" key={index} aria-hidden="true">
          <div className="agq-skeleton-label" />
          <div className="agq-skeleton-track" />
          <div className="agq-skeleton-percent" />
          <div className="agq-skeleton-time" />
        </div>
      ))}
    </div>
  );
}

/** loadUsage accepts an AbortSignal; resetAt values are Unix milliseconds. */
export function QuotaPopover({ loadUsage }) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const trigger = useRef(null);
  const panel = useRef(null);
  const pending = useRef(null);
  const id = useId();

  const close = useCallback(() => {
    pending.current?.abort();
    setOpen(false);
    setRequest({ status: 'loading' });
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    pending.current = controller;
    setRequest({ status: 'loading' });
    setNow(Date.now());
    async function fetchUsage() {
      try {
        const data = await loadUsage(controller.signal);
        if (!controller.signal.aborted) setRequest({ status: 'ready', data });
      } catch (error) {
        if (!controller.signal.aborted)
          setRequest({
            status: 'error',
            message: error instanceof Error ? error.message : '暂时无法读取账户额度，请重试。',
          });
      }
    }
    void fetchUsage();
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [open, revision, loadUsage]);

  useLayoutEffect(() => {
    if (!open) return;
    const element = panel.current;
    const button = trigger.current;
    const gap = 8;
    const margin = 12;
    const position = () => {
      const anchor = button.getBoundingClientRect();
      const below = window.innerHeight - anchor.bottom - gap - margin;
      const above = anchor.top - gap - margin;
      const upward = element.scrollHeight > below && above > below;
      element.style.maxHeight = `${Math.max(0, upward ? above : below)}px`;
      const bounds = element.getBoundingClientRect();
      const left = Math.max(
        margin,
        Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - margin),
      );
      const top = upward ? anchor.top - bounds.height - gap : anchor.bottom + gap;
      element.style.left = `${left}px`;
      element.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - bounds.height - margin))}px`;
      element.style.visibility = 'visible';
    };
    const toggle = (event) => {
      if (event.newState === 'closed') close();
    };
    const outside = (event) => {
      const path = event.composedPath();
      if (!path.includes(element) && !path.includes(button)) close();
    };
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
      button.focus();
    };
    element.addEventListener('toggle', toggle);
    element.showPopover();
    position();
    element.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
      element.removeEventListener('toggle', toggle);
      element.hidePopover();
    };
  }, [open, close]);

  const retry = () => setRevision((value) => value + 1);
  const data = request.status === 'ready' ? request.data : null;

  return (
    <>
      <style>{css}</style>
      <button
        ref={trigger}
        type="button"
        className="agq-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title="查看 Antigravity 账户额度"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span>Antigravity</span>
        <span className="agq-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <section
          id={id}
          ref={panel}
          className="agq-panel"
          popover="manual"
          role="dialog"
          aria-label="Antigravity 账户额度"
          aria-busy={request.status === 'loading'}
          tabIndex={-1}
        >
          <header className="agq-header">
            <h2>Antigravity</h2>
            <button
              type="button"
              className="agq-icon-button"
              aria-label="刷新额度"
              title="刷新额度"
              disabled={request.status === 'loading'}
              onClick={retry}
            >
              <Icon name="refresh" />
            </button>
          </header>
          {request.status === 'loading' && <Loading />}
          {request.status === 'error' && (
            <div className="agq-message" role="alert">
              <p>{request.message}</p>
              <button type="button" className="agq-retry" onClick={retry}>
                <Icon name="refresh" />
                重试
              </button>
            </div>
          )}
          {data && (
            <>
              <div className="agq-account">
                <span className="agq-email" title={data.email || undefined}>
                  {data.email || '账户信息暂不可用'}
                </span>
                {data.plan && (
                  <span className="agq-plan" title={data.plan}>
                    {data.plan}
                  </span>
                )}
              </div>
              <div className="agq-quotas">
                {data.rows.map((row, index) => (
                  <QuotaRow key={`${row.label}-${index}`} row={row} now={now} />
                ))}
                {!data.rows.length && (
                  <div className="agq-no-rows">
                    {data.ok ? '暂无模型额度信息' : '暂时无法读取模型额度'}
                    <button type="button" className="agq-retry" onClick={retry}>
                      <Icon name="refresh" />
                      重试
                    </button>
                  </div>
                )}
              </div>
              <div className="agq-balance">{data.balance}</div>
              {!!data.notes.length && (
                <div className="agq-notes" role={data.ok ? 'status' : 'alert'}>
                  {data.notes.map((note, index) => (
                    <p key={index}>{note}</p>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}
