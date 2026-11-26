import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, transform } from 'esbuild';
import { compile } from 'sass';

const root = new URL('../', import.meta.url);
const web = new URL('deploy/leon-home/files/usr/local/lib/leon-overview/web/', root);
const output = new URL('dist/', web);
const previous = new URL('.build/web-previous/', root);
const compiler = fileURLToPath(new URL('node_modules/typescript/bin/tsc', root));
execFileSync(process.execPath, [compiler, '--project', 'tsconfig.worker.json', '--noEmit'], { cwd: root, stdio: 'inherit' });
// Unbundled modules are test inputs only; they are never part of the served asset manifest.
// Emission checks browser types once; noEmitOnError keeps invalid output out of this build.
execFileSync(process.execPath, [compiler, '--project', 'tsconfig.web.json'], { cwd: root, stdio: 'inherit' });
await mkdir(new URL('.build/', root), { recursive: true });
const stage = await mkdtemp(fileURLToPath(new URL('.build/web-stage-', root)));
try {
  const result = await build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [fileURLToPath(new URL('src/updates.ts', web)), { in: fileURLToPath(new URL('src/main.ts', web)), out: 'leon' }],
    outdir: stage,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    metafile: true,
    legalComments: 'none',
    logLevel: 'error',
  });
  // Styles are written in Sass (web/styles); each entry compiles to the served stylesheet of the same name.
  const stylesheetSizes = {};
  for (const name of ['home', 'updates', 'leon']) {
    const entry = fileURLToPath(new URL(`styles/${name}.scss`, web));
    const compiled = compile(entry, { style: 'expanded', sourceMap: false });
    const result = await transform(compiled.css, { loader: 'css', minify: true, target: ['safari16.4', 'chrome110'], legalComments: 'none' });
    await writeFile(join(stage, `${name}.css`), result.code);
    stylesheetSizes[`${name}.css`] = { compiledBytes: Buffer.byteLength(compiled.css), builtBytes: Buffer.byteLength(result.code) };
  }
  // Fixed URLs require a content-derived cache name: every installed build gets its own complete set.
  const revision = createHash('sha256');
  for (const name of ['leon.js', 'updates.js', 'home.css', 'leon.css', 'updates.css']) revision.update(await readFile(join(stage, name)));
  revision.update(await readFile(new URL('worker/serviceWorker.ts', web)));
  revision.update(await readFile(new URL('../overview.py', web)));
  for (const name of ['symbol-web.png', 'wordmark-web.png', 'icon-512.png']) {
    revision.update(await readFile(new URL(`../../../share/leon-home/${name}`, web)));
  }
  await build({
    entryPoints: [fileURLToPath(new URL('worker/serviceWorker.ts', web))],
    outfile: join(stage, 'serviceWorker.js'),
    define: { __LEON_ASSET_VERSION__: JSON.stringify(revision.digest('hex').slice(0, 16)) },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    logLevel: 'error',
  });
  let unbundledJavaScriptBytes = 0;
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.endsWith('.ts')) continue;
    const name = relative(fileURLToPath(new URL('src/', web)), fileURLToPath(new URL(input, root))).replace(/\.ts$/, '.js');
    unbundledJavaScriptBytes += (await readFile(new URL(`.build/web-modules/${name}`, root))).length;
  }
  const report = {
    unbundledJavaScriptBytes,
    bundledUpdatesBytes: (await readFile(join(stage, 'updates.js'))).length,
    bundledLeonBytes: (await readFile(join(stage, 'leon.js'))).length,
    stylesheetSizes,
    workerBytes: (await readFile(join(stage, 'serviceWorker.js'))).length,
  };
  await rm(previous, { recursive: true, force: true });
  let hadPrevious = false;
  try {
    await rename(output, previous);
    hadPrevious = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(stage, output);
  } catch (error) {
    if (hadPrevious) await rename(previous, output);
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
  await writeFile(new URL('.build/web-build-report.json', root), `${JSON.stringify(report, null, 2)}\n`);
  console.log('Built optimized TypeScript app (leon), updates, worker and styles; no Node runtime on the Pi.');
  console.log(JSON.stringify(report));
} finally {
  await rm(stage, { recursive: true, force: true });
}
