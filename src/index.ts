import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-working-directory';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import z from '@deepseek-ai/schemastery';
import { AcpEndpoint } from './acp/endpoint.js';

export const name = 'dsh-antigravity';
export const inject = ['connection'];
export interface Config {
  acpBinaryPath?: string;
}
export const Config = z.object({
  acpBinaryPath: z
    .string()
    .default('agy')
    .description('Antigravity CLI executable on the Harness host.'),
});

export function apply(ctx: Context, config: Config): void {
  const endpoint = new AcpEndpoint(async (id, signal) => {
    const agent = ctx.get('agents')?.get(SessionId(id));
    if (!agent) throw new Error('请先在 Harness 中打开一个本机项目会话。');
    const directories = agent.ctx.get('workingDirectory');
    const fs = agent.ctx.get('fs');
    if (!directories || !fs) throw new Error('当前会话未提供本机工作目录。');
    const cwd = await directories.ensure(agent, signal);
    if (!isAbsolute(cwd) || fs.processPathFromHostPath(cwd) !== cwd) {
      throw new Error('Antigravity 会话需要可在本机访问的项目目录。');
    }
    return realpath(cwd);
  }, config.acpBinaryPath || 'agy');
  ctx.effect(() => () => endpoint.dispose());
  ctx.connection.fetch.register({
    path: '/api/antigravity/acp',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => endpoint.fetch(request),
  });
}
