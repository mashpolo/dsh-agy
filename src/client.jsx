import { AcpPanel } from './AcpPanel.jsx';
export const inject = ['slots'];

export function apply(ctx) {
  const slot = 'conversation.session.header.actions';
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
