import { createRequire } from 'node:module';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = process.env.OC_AUTH_PROBE_NODE_MODULES || path.join(root, 'node_modules');
const output = path.resolve(process.env.OC_AUTH_PROBE_OUTPUT || path.join(root, 'dist'));
const require = createRequire(path.join(moduleRoot, '__auth_probe_resolver.cjs'));
const expected = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const [name, version] of Object.entries({ ...expected.dependencies, ...expected.devDependencies })) {
  const actual = JSON.parse(await readFile(path.join(moduleRoot, name, 'package.json'), 'utf8'));
  if (actual.version !== version) throw new Error(`Installed ${name} does not match pinned ${version}`);
}
const { build } = require('esbuild');
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, 'app.mjs')], bundle: true, platform: 'browser', format: 'esm',
  target: 'es2022', outfile: path.join(output, 'app.js'), nodePaths: [moduleRoot], minify: false,
  sourcemap: false, legalComments: 'linked', logLevel: 'warning' });
for (const file of ['index.html', 'styles.css']) await copyFile(path.join(root, file), path.join(output, file));
console.log('Local authentication proof built; no account or network operation performed.');
