import { build } from 'esbuild';
import { readFile, mkdir, writeFile, chmod, copyFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

// These small, version-pinned substitutions remove Pi-owned state from the reused protocol code.
// Keep them here so an upstream upgrade has one explicit compatibility boundary to review.
function replaceOnce(source, before, after, path) {
  if (source.split(before).length !== 2)
    throw new Error(`Upstream source changed; review the adapter for ${path}`);
  return source.replace(before, after);
}

const hostIsolation = {
  name: 'antigravity-host-isolation',
  setup(build) {
    build.onLoad({ filter: /pi-antigravity\/src\/auth\/accounts\.ts$/ }, () => ({
      contents: 'export async function failoverToNextAccount() { return undefined; }',
      loader: 'js',
    }));
    build.onLoad({ filter: /pi-antigravity\/src\/utils\/credits\.ts$/ }, () => ({
      contents: 'export function isCreditsEnabled() { return false; }',
      loader: 'js',
    }));
    build.onLoad(
      {
        filter:
          /pi-antigravity\/src\/(models\/discovery|client\/enterprise|client\/client|stream\/stream|auth\/oauth)\.ts$/,
      },
      async ({ path }) => {
        let contents = await readFile(path, 'utf8');
        if (path.endsWith('/models/discovery.ts')) {
          contents = replaceOnce(
            contents,
            'from "../auth/index.js"',
            'from "../auth/oauth.js"',
            path,
          );
        } else if (path.endsWith('/client/enterprise.ts')) {
          contents = replaceOnce(
            contents,
            'const settings = readCliSettings();',
            'const settings: Record<string, unknown> | undefined = undefined;',
            path,
          );
        } else if (path.endsWith('/client/client.ts')) {
          contents =
            "import { attributionHeaders as dshAttributionHeaders } from '@deepseek-ai/dsh-llm';\n" +
            contents;
          contents = replaceOnce(
            contents,
            '"User-Agent": antigravityEnv("USER_AGENT") || defaultUserAgent(),',
            '"User-Agent": [(antigravityEnv("USER_AGENT") || defaultUserAgent()), dshAttributionHeaders()["user-agent"]].join(" "),',
            path,
          );
        } else if (path.endsWith('/auth/oauth.ts')) {
          contents = replaceOnce(
            contents,
            'You can close this window and return to Pi.',
            'You can close this window and return to DeepSeek Harness.',
            path,
          );
        } else {
          contents = replaceOnce(contents, 'antigravityEnv("DEBUG_DUMP") === "1"', 'false', path);
        }
        contents = contents.replaceAll('/login antigravity', 'dsh-antigravity-login');
        return { contents, loader: 'ts' };
      },
    );
  },
};

for (const name of ['pi-antigravity', '@deepseek-ai/dsh-llm-pi-ai']) {
  const directory = `dist/licenses/${name}`;
  await mkdir(directory, { recursive: true });
  await copyFile(`node_modules/${name}/LICENSE`, `${directory}/LICENSE`);
}

const options = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  external: [...Object.keys(pkg.peerDependencies), ...Object.keys(pkg.dependencies)],
  plugins: [hostIsolation],
  metafile: true,
  legalComments: 'eof',
  minifySyntax: true,
};
const result = await build({ ...options, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' });
await build({
  ...options,
  stdin: {
    contents: "import { runLogin } from './src/auth.ts'; await runLogin();",
    resolveDir: process.cwd(),
    sourcefile: 'login-entry.ts',
    loader: 'ts',
  },
  outfile: 'dist/login.js',
  banner: { js: '#!/usr/bin/env node' },
});
await chmod('dist/login.js', 0o755);
// The Harness browser loader supplies React and owns the lifetime of each plugin factory.
await build({
  entryPoints: ['src/client.jsx'],
  outfile: 'dist/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  loader: { '.css': 'text' },
  external: ['react', 'react-dom'],
  banner: {
    js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory(require){const module={exports:{}};const exports=module.exports;`,
  },
  footer: { js: 'return module.exports;}});' },
});
// A build artifact, useful when auditing exactly which pinned sources were bundled.
await writeFile('dist/build-meta.json', JSON.stringify(result.metafile, null, 2) + '\n');
console.log('Built dist/index.js (native DSH plugin, with upstream protocol modules bundled).');
