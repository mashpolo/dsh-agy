import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type {} from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { AcpEndpoint } from './acp/endpoint.js';
import { prepareLaunch } from './acp/launch.js';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-authorization';
import type {} from '@deepseek-ai/dsh-client-connection';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { usagePath } from './usage-route.js';
import z from '@deepseek-ai/schemastery';
import { CREDENTIAL_KEY, createAuth, createLoginFlow } from './auth.js';
import { AntigravityAdapter, PROVIDER } from './provider.js';
import { queryUsage, registerUsage } from './usage.js';
import { registerTools } from './tools.js';

export const name = 'dsh-antigravity';
export const inject = ['llm', 'credentials'];
export interface Config {
  maxPageChars: number;
  acpBinaryPath?: string;
}
export const Config = z.object({
  acpBinaryPath: z
    .string()
    .default('agy')
    .description('Antigravity CLI executable on the Harness host.'),
  maxPageChars: z
    .number()
    .min(1000)
    .max(200000)
    .default(60000)
    .description(
      'Maximum characters returned from a web page; the full page is saved in the session working directory.',
    ),
});

export function apply(ctx: Context, config: Config): void {
  const auth = createAuth(ctx.credentials);
  const adapter = new AntigravityAdapter(ctx, auth);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.on('credentials/record-updated', (key) => {
    if (key !== CREDENTIAL_KEY) return;
    adapter.invalidate();
    ctx.emit('llm/models-updated', PROVIDER);
  });
  ctx.inject(['connection'], (child) => {
    child.connection.fetch.register({
      path: '/' + usagePath,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const headers = { 'Cache-Control': 'no-store' };
        try {
          return Response.json(await queryUsage(auth, request.signal), { headers });
        } catch (error) {
          request.signal.throwIfAborted();
          const authError =
            error instanceof LlmError &&
            ['MISSING_CREDENTIAL', 'AUTH'].includes(error.failure.code);
          return Response.json(
            {
              error: authError
                ? '请先用 dsh-antigravity-login 登录 Google 账号。'
                : '暂时无法读取额度，请稍后重试。',
            },
            { headers, status: authError ? 401 : 502 },
          );
        }
      },
    });
  });
  ctx.inject(['connection'], (child) => {
    const endpoint = new AcpEndpoint(
      async (id, signal) => {
        const agent = child.get('agents')?.get(SessionId(id));
        if (!agent) throw new Error('请先在 Harness 中打开一个本机项目会话。');
        const directories = agent.ctx.get('workingDirectory');
        const fs = agent.ctx.get('fs');
        if (!directories || !fs) throw new Error('当前会话未提供本机工作目录。');
        const cwd = await directories.ensure(agent, signal);
        if (!isAbsolute(cwd) || fs.processPathFromHostPath(cwd) !== cwd) {
          throw new Error('独立 ACP 会话需要可在本机访问的项目目录。');
        }
        return realpath(cwd);
      },
      (cwd) => prepareLaunch({ command: config.acpBinaryPath || 'agy', cwd }),
    );
    child.effect(() => () => endpoint.dispose());
    child.connection.fetch.register({
      path: '/api/antigravity/acp',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => endpoint.fetch(request),
    });
  });
  ctx.inject(['commands'], (child) => registerUsage(child, auth));
  ctx.inject(['authorization'], (child) => {
    child.authorization.registerFlow(createLoginFlow());
    child.on('authorization/settled', (key, result) => {
      if (key !== CREDENTIAL_KEY || result !== 'authorized') return;
      adapter.invalidate();
      ctx.emit('llm/models-updated', PROVIDER);
    });
  });
  ctx.inject(['tools', 'attachments', 'fs', 'workingDirectory'], (child) =>
    registerTools(child, auth, config),
  );
}

export { AntigravityAdapter } from './provider.js';
