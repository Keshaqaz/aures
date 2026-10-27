// Bundles the worker into one readable Apps Script file, which setup, upgrade and «Починить» put
// into the user's script project.
import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('..', import.meta.url));

// The worker as one Apps Script file: no modules, the global functions tick, doGet and doPost.
// Async functions are compiled to generators over the global Promise, which the wrapper
// shadows with the bundle's own synchronous one (src/apps-script/sync-promise.ts), together
// with AbortSignal and Buffer. node:crypto becomes Utilities.getUuid.
export async function appsScriptSource(): Promise<string> {
  const { outputFiles: [bundle] = [] } = await build({
    entryPoints: [`${root}src/apps-script/main.ts`], bundle: true, write: false, platform: 'neutral', format: 'iife',
    globalName: 'AuresWorker', alias: { 'node:crypto': `${root}src/apps-script/node-crypto.ts` },
    tsconfigRaw: {}, target: 'es2017', supported: { 'async-await': false }, minify: false, legalComments: 'none', logLevel: 'warning',
  });
  if (!bundle) throw new Error('esbuild wrote no bundle');
  return [
    `// aures worker ${pkg.version} for Apps Script, built from src/apps-script/main.ts. Do not edit.`,
    'var AuresWorker = (function () {',
    '  var Promise, AbortSignal, Buffer;',
    bundle.text,
    '  ({ Promise, AbortSignal, Buffer } = AuresWorker.platform);',
    '  return AuresWorker;',
    '})();',
    'function tick() { AuresWorker.tick(); }',
    'function doGet(e) { return AuresWorker.doGet(e); }',
    'function doPost(e) { return AuresWorker.doPost(e); }',
    '',
  ].join('\n');
}

export async function buildAppsScript(outfile = `${root}dist/apps-script/worker.js`): Promise<string> {
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, await appsScriptSource());
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(await buildAppsScript());
}
