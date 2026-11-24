import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-commands';
import {
  antigravityHeaders,
  endpointCandidates,
  fetchAvailableModelsCatalog,
  parseApiKey,
} from 'pi-antigravity/src/client/client.js';
import { antigravityFetch } from 'pi-antigravity/src/utils/http.js';
import { isRecord } from 'pi-antigravity/src/utils/util.js';
import type { Auth } from './auth.js';

export interface UsageRow {
  label: string;
  shortLabel: string;
  fraction: number | null;
  resetAt: number | null;
}

export interface UsageResult {
  email: string | null;
  plan: string | null;
  rows: UsageRow[];
  notes: string[];
  balance: string;
  ok: boolean;
}

// Only shorten observed API group names; a future group may have a different quota pool.
const groupLabels = new Map([
  ['gemini models', 'Gemini'],
  ['claude and gpt models', 'Claude/GPT'],
]);

const resetClock = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'shortOffset',
});

async function readAccountRpc(method: string, body: object, token: string, signal: AbortSignal) {
  let problem = '网络请求失败';
  for (const endpoint of endpointCandidates()) {
    signal.throwIfAborted();
    try {
      const res = await antigravityFetch(endpoint + '/v1internal:' + method, {
        method: 'POST',
        headers: antigravityHeaders(token),
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (res.ok) {
        const data: unknown = await res.json();
        if (isRecord(data)) return data;
        problem = '响应格式异常';
      } else {
        problem = 'HTTP ' + res.status;
        await res.body?.cancel();
        if (res.status === 401) break;
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  throw new Error(problem);
}

function quotaLine({ label, fraction, resetAt }: UsageRow) {
  const remaining =
    fraction !== null
      ? ' ' +
        (fraction > 0 && fraction < 0.001
          ? '<0.1'
          : Math.round(Math.max(0, Math.min(1, fraction)) * 1000) / 10) +
        '%'
      : '未返回';
  return (
    label +
    ' · 剩余' +
    remaining +
    ' · 重置时间' +
    (resetAt !== null ? ' ' + resetClock.format(resetAt) : '未返回')
  );
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function quotaRow(label: string, shortLabel: string, fraction: unknown, reset: unknown): UsageRow {
  const resetAt = typeof reset === 'string' ? Date.parse(reset) : NaN;
  return {
    label,
    shortLabel,
    fraction:
      typeof fraction === 'number' && Number.isFinite(fraction)
        ? Math.max(0, Math.min(1, fraction))
        : null,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
  };
}

function period(bucket: Record<string, unknown>): '5h' | '周' | undefined {
  for (const value of [bucket.window, bucket.displayName]) {
    if (typeof value !== 'string') continue;
    if (/five[\s_-]*hours?|\b5[\s_-]*(?:hours?|h)\b/i.test(value)) return '5h';
    if (/weekly|\bweek\b/i.test(value)) return '周';
  }
  return undefined;
}

function groupRows(groups: unknown): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const groupName = text(group.displayName);
    const family = groupLabels.get(groupName?.toLowerCase() ?? '');
    const rank = (bucket: Record<string, unknown>) =>
      period(bucket) === '5h' ? 0 : period(bucket) === '周' ? 1 : 2;
    for (const bucket of group.buckets.filter(isRecord).toSorted((a, b) => rank(a) - rank(b))) {
      const label =
        [groupName, text(bucket.displayName) || text(bucket.bucketId)]
          .filter(Boolean)
          .join(' / ') || '共享额度';
      const window = period(bucket);
      rows.push(
        quotaRow(
          label,
          family && window ? `${family} ${window}` : label,
          bucket.remainingFraction,
          bucket.resetTime,
        ),
      );
    }
  }
  return rows;
}

function creditRows(account: Record<string, unknown>): string[] {
  for (const tier of [account.paidTier, account.currentTier, account]) {
    if (!isRecord(tier)) continue;
    const entries = tier.availableCredits ?? tier.available_credits;
    if (!Array.isArray(entries)) continue;
    const rows: string[] = [];
    for (const entry of entries.filter(isRecord)) {
      const raw = entry.creditAmount ?? entry.credit_amount;
      const amount = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
      if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
      rows.push(String(entry.creditType ?? entry.credit_type ?? 'GOOGLE_ONE_AI') + '  ' + amount);
    }
    if (rows.length) return rows;
  }
  return [];
}

function planLabel(account: Record<string, unknown>): string | null {
  for (const tier of [account.paidTier, account.currentTier]) {
    if (!isRecord(tier)) continue;
    const label = text(tier.name) || text(tier.id);
    if (label) return label;
  }
  return null;
}

/** Shared read model for the quota panel and the existing slash command. */
export async function queryUsage(auth: Auth, signal: AbortSignal): Promise<UsageResult> {
  signal.throwIfAborted();
  const session = await auth.getSession();
  signal.throwIfAborted();
  const { token, projectId } = parseApiKey(session.apiKey);
  const [summary, assist] = await Promise.allSettled([
    readAccountRpc('retrieveUserQuotaSummary', {}, token, signal),
    readAccountRpc(
      'loadCodeAssist',
      {
        metadata: {
          ideType: 'ANTIGRAVITY',
          platform: 'PLATFORM_UNSPECIFIED',
          pluginType: 'GEMINI',
        },
      },
      token,
      signal,
    ),
  ]);
  signal.throwIfAborted();
  let rows = summary.status === 'fulfilled' ? groupRows(summary.value.groups) : [];
  const notes: string[] = [];
  let hasResponse = summary.status === 'fulfilled' || assist.status === 'fulfilled';
  if (!rows.length) {
    notes.push(
      summary.status === 'rejected'
        ? '共享额度查询失败（' + summary.reason.message + '）'
        : '共享额度未返回',
    );
    try {
      const { data } = await fetchAvailableModelsCatalog(token, projectId, signal);
      hasResponse = true;
      rows = Object.entries(data.models ?? {})
        .filter(([id, model]) => !model.isInternal && !/^(tab_|chat_)/i.test(id) && model.quotaInfo)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, model]) =>
          quotaRow(
            text(model.displayName) || id,
            text(model.displayName) || id,
            model.quotaInfo?.remainingFraction,
            model.quotaInfo?.resetTime,
          ),
        );
      notes.push(rows.length ? '按模型显示（多个模型可能共用额度）' : '模型额度未返回');
    } catch {
      signal.throwIfAborted();
      notes.push('模型额度查询失败');
    }
  }
  signal.throwIfAborted();
  const credits = assist.status === 'fulfilled' ? creditRows(assist.value) : [];
  const balance = credits.length
    ? ['AI credits 余额', ...credits].join('\n')
    : assist.status === 'rejected'
      ? 'AI credits 余额查询失败（' + assist.reason.message + '）'
      : 'AI credits 余额未返回';
  return {
    email: text(session.email),
    plan: assist.status === 'fulfilled' ? planLabel(assist.value) : null,
    rows,
    notes,
    balance,
    ok: hasResponse,
  };
}

export function registerUsage(ctx: Context, auth: Auth) {
  ctx.commands.register({
    name: 'antigravity-usage',
    description: '查看 Antigravity 剩余额度、重置时间和 AI credits 余额',
    async handler({ signal }) {
      const usage = await queryUsage(auth, signal);
      return {
        kind: usage.ok ? 'success' : 'error',
        text: [...usage.notes, ...usage.rows.map(quotaLine), '', usage.balance].join('\n'),
      };
    },
  });
}
