import { LlmError, ReasoningEffortId, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { isRecord } from './client.js';

export const PROVIDER = 'antigravity';
const orderedEfforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export interface ModelDefinition {
  id: string;
  name: string;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  routes: Record<string, string>;
  defaultEffort: string;
}
export type ModelCatalog = Map<string, ModelDefinition>;
const specialRoutes: Record<string, { id: string; effort: string }> = {
  'gemini-3.5-flash-extra-low': { id: 'gemini-3.5-flash', effort: 'low' },
  'gemini-3.5-flash-low': { id: 'gemini-3.5-flash', effort: 'medium' },
  'gemini-3-flash-agent': { id: 'gemini-3.5-flash', effort: 'high' },
  'gemini-pro-agent': { id: 'gemini-3.1-pro', effort: 'high' },
};
function splitRuntime(id: string): { id: string; effort?: string } {
  if (specialRoutes[id]) return specialRoutes[id];
  const suffix = /-(extra-low|extra-high|xhigh|minimal|low|medium|high|thinking|think)$/.exec(id);
  if (!suffix) return { id };
  const level = suffix[1];
  return {
    id: id.slice(0, -suffix[0].length),
    effort:
      level === 'extra-low'
        ? 'minimal'
        : level === 'extra-high'
          ? 'xhigh'
          : level === 'thinking' || level === 'think'
            ? 'high'
            : level,
  };
}
function fallback(
  id: string,
  name: string,
  routes: Record<string, string>,
  image = true,
): ModelDefinition {
  return {
    id,
    name,
    routes,
    input: image ? ['text', 'image'] : ['text'],
    contextWindow: id.startsWith('claude') ? 200000 : id.startsWith('gemini') ? 1048576 : 131072,
    maxTokens: id.startsWith('claude') ? 64000 : id.startsWith('gemini') ? 65536 : 32768,
    defaultEffort: Object.keys(routes)[0],
  };
}
export function fallbackCatalog(): ModelCatalog {
  const models = [
    ...['3.8', '3.7', '3.6'].map((version) =>
      fallback(
        `gemini-${version}-flash`,
        `Gemini ${version} Flash`,
        Object.fromEntries(
          ['low', 'medium', 'high'].map((e) => [e, `gemini-${version}-flash-${e}`]),
        ),
      ),
    ),
    ...['opus', 'sonnet'].map((name) =>
      fallback(
        `claude-${name}-4-6`,
        `Claude ${name === 'opus' ? 'Opus' : 'Sonnet'} 4.6`,
        Object.fromEntries(['off', 'low', 'medium', 'high'].map((e) => [e, `claude-${name}-4-6`])),
      ),
    ),
    fallback('gemini-3.1-pro', 'Gemini 3.1 Pro', {
      low: 'gemini-3.1-pro-low',
      high: 'gemini-pro-agent',
    }),
    fallback('gemini-3.5-flash', 'Gemini 3.5 Flash', {
      low: 'gemini-3.5-flash-extra-low',
      medium: 'gemini-3.5-flash-low',
      high: 'gemini-3-flash-agent',
    }),
    fallback(
      'gpt-oss-120b',
      'GPT OSS 120B',
      {
        off: 'gpt-oss-120b-medium',
        low: 'gpt-oss-120b-medium',
        medium: 'gpt-oss-120b-medium',
        high: 'gpt-oss-120b-medium',
      },
      false,
    ),
  ];
  return new Map(models.map((model) => [model.id, model]));
}
function positive(...values: unknown[]): number | undefined {
  return values.find((n): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
}

/** Catalog values come from the service, while routing stays local to this adapter. */
export function buildCatalog(
  entries: Record<string, Record<string, unknown>>,
  sorts?: unknown,
): ModelCatalog {
  const result: ModelCatalog = new Map();
  const defaults = fallbackCatalog();
  for (const [runtimeId, info] of Object.entries(entries)) {
    if (
      info.isInternal === true ||
      /^(tab_|chat_)/i.test(runtimeId) ||
      /image|imagen|embedding|tts/i.test(runtimeId)
    )
      continue;
    const split = splitRuntime(runtimeId);
    const base = defaults.get(split.id);
    const effort =
      split.effort ??
      /\((minimal|low|medium|high|xhigh)\)\s*$/i
        .exec(String(info.displayName ?? ''))?.[1]
        .toLowerCase();
    const routes = effort
      ? { [effort]: runtimeId }
      : Object.fromEntries(
          (info.supportsThinking === true ? ['off', 'low', 'medium', 'high'] : ['off']).map(
            (level) => [level, runtimeId],
          ),
        );
    const previous = result.get(split.id);
    const contextWindow =
      positive(info.contextWindow, info.maxInputTokens, info.maxTokens) ??
      base?.contextWindow ??
      128000;
    const maxTokens = positive(info.maxOutputTokens) ?? base?.maxTokens ?? 8192;
    const label =
      typeof info.displayName === 'string'
        ? info.displayName
        : typeof info.modelName === 'string'
          ? info.modelName
          : split.id;
    result.set(split.id, {
      id: split.id,
      name:
        base?.name ??
        label
          .replace(
            /\s*\(?(?:extra[- ]low|extra[- ]high|minimal|low|medium|high|xhigh|thinking)\)?$/i,
            '',
          )
          .trim(),
      input:
        info.supportsImages === true ||
        (info.supportsImages !== false && base?.input.includes('image'))
          ? ['text', 'image']
          : ['text'],
      contextWindow: previous ? Math.min(previous.contextWindow, contextWindow) : contextWindow,
      maxTokens: previous ? Math.min(previous.maxTokens, maxTokens) : maxTokens,
      routes: { ...previous?.routes, ...routes },
      defaultEffort: '',
    });
  }
  if (!result.size)
    throw new LlmError('Antigravity returned no conversational models.', 'INVALID_CATALOG');
  for (const model of result.values())
    model.defaultEffort =
      orderedEfforts.find((e) => model.routes[e]) ?? Object.keys(model.routes)[0];
  const recommended: ModelCatalog = new Map();
  for (const sort of Array.isArray(sorts) ? sorts : []) {
    if (!isRecord(sort) || !Array.isArray(sort.groups)) continue;
    for (const group of sort.groups) {
      if (!isRecord(group) || !Array.isArray(group.modelIds)) continue;
      for (const id of group.modelIds) {
        if (typeof id !== 'string') continue;
        const model = result.get(splitRuntime(id).id);
        if (model) recommended.set(model.id, model);
      }
    }
  }
  return recommended.size ? recommended : result;
}

/** Retain exact runtime IDs and the old -thinking/-think aliases for saved sessions. */
export function resolveDefinition(catalog: ModelCatalog, id: string): ModelDefinition {
  const direct = catalog.get(id) ?? fallbackCatalog().get(id);
  if (direct) return direct;
  const split = splitRuntime(id);
  const base = catalog.get(split.id) ?? fallbackCatalog().get(split.id);
  if (base && split.effort && base.routes[split.effort])
    return { ...base, id, defaultEffort: split.effort };
  for (const model of catalog.values()) {
    const effort = Object.keys(model.routes).find((level) => model.routes[level] === id);
    if (effort) return { ...model, id, defaultEffort: effort };
  }
  throw new LlmError(
    'The selected Antigravity model is unavailable. Refresh the model list.',
    'INVALID_REQUEST',
  );
}
export function canonicalId(model: ModelDefinition): string {
  return splitRuntime(model.id).id;
}
export function modelInfo(model: ModelDefinition): LlmResolvedModelInfo {
  return {
    provider: PROVIDER,
    id: model.id,
    name: model.name,
    inputModalities: model.input,
    context: { contextWindow: model.contextWindow },
    defaultMaxTokens: model.maxTokens,
    reasoning: {
      efforts: orderedEfforts
        .filter((e) => model.routes[e])
        .map((e) => ({ id: ReasoningEffortId(e), name: e })),
      defaultEffort: ReasoningEffortId(model.defaultEffort),
    },
  };
}
export function selectRoute(
  model: ModelDefinition,
  requested?: string,
): { runtimeId: string; thinkingConfig?: Record<string, unknown> } {
  const effort = requested ?? model.defaultEffort;
  const runtimeId = model.routes[effort];
  if (!runtimeId)
    throw new LlmError(
      'The selected reasoning effort is unavailable for this model.',
      'UNSUPPORTED_REASONING_EFFORT',
    );
  if (effort === 'off')
    return {
      runtimeId,
      ...(/gemini-(?:4|.*argon)/i.test(model.id)
        ? {}
        : { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } }),
    };
  let budget =
    (
      { minimal: 1000, low: 1000, medium: 4000, high: -1, xhigh: -1, max: -1 } as Record<
        string,
        number
      >
    )[effort] ?? -1;
  if (model.id.startsWith('claude')) budget = 1024;
  if (model.id.startsWith('gpt')) budget = 8192;
  if (canonicalId(model) === 'gemini-3.1-pro') budget = effort === 'low' ? 1001 : 10001;
  if (canonicalId(model) === 'gemini-3.5-flash') budget = effort === 'high' ? 10000 : budget;
  return { runtimeId, thinkingConfig: { includeThoughts: true, thinkingBudget: budget } };
}
