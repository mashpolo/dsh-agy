import { build } from 'esbuild';
import { readFile, chmod } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

const options = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  external: [...Object.keys(pkg.peerDependencies), ...Object.keys(pkg.dependencies)],
  legalComments: 'eof',
  minifySyntax: true,
};
await build({ ...options, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' });
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
