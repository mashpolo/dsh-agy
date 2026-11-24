import { AcpPanel } from './AcpPanel.jsx';
import { QuotaPopover } from './QuotaPopover.jsx';
import { usagePath } from './usage-route.ts';

export const inject = ['slots'];

async function loadUsage(signal) {
  const response = await fetch(usagePath, { signal, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || '额度查询失败（HTTP ' + response.status + '）');
  }
  return response.json();
}

export function apply(ctx) {
  const slot = 'conversation.session.header.actions';
  ctx.slots.inject(slot, () =>
    ctx.slots.register(
      {
        name: slot,
        id: 'antigravity-quota',
        order: 25,
        inject: () => ({ loadUsage }),
      },
      QuotaPopover,
    ),
  );
  ctx.slots.inject(slot, () =>
    ctx.slots.register(
      {
        name: slot,
        id: 'antigravity-acp',
        order: 26,
        inject: (hostSessionId) => ({ hostSessionId }),
      },
      AcpPanel,
    ),
  );
}
