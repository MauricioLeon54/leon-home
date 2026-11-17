import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, transform } from 'esbuild';

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
    entryPoints: [new URL('src/app.ts', web), new URL('src/home.ts', web), new URL('src/updates.ts', web)].map(fileURLToPath),
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
  await build({
    entryPoints: [fileURLToPath(new URL('worker/serviceWorker.ts', web))],
    outfile: join(stage, 'serviceWorker.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    logLevel: 'error',
  });
  const stylesheetSizes = {};
  for (const name of ['network-map.css', 'home.css', 'updates.css']) {
    const source = await readFile(new URL(name, web), 'utf8');
    const result = await transform(source, { loader: 'css', minify: true, target: ['safari16.4', 'chrome110'], legalComments: 'none' });
    await writeFile(join(stage, name), result.code);
    stylesheetSizes[name] = { sourceBytes: Buffer.byteLength(source), builtBytes: Buffer.byteLength(result.code) };
  }
  let unbundledJavaScriptBytes = 0;
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.endsWith('.ts')) continue;
    const name = relative(fileURLToPath(new URL('src/', web)), fileURLToPath(new URL(input, root))).replace(/\.ts$/, '.js');
    unbundledJavaScriptBytes += (await readFile(new URL('.build/web-modules/' + name, root))).length;
  }
  const report = {
    unbundledJavaScriptBytes,
    bundledAppBytes: (await readFile(join(stage, 'app.js'))).length,
    bundledHomeBytes: (await readFile(join(stage, 'home.js'))).length,
    bundledUpdatesBytes: (await readFile(join(stage, 'updates.js'))).length,
    stylesheetSizes,
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
  await writeFile(new URL('.build/web-build-report.json', root), JSON.stringify(report, null, 2) + '\n');
  console.log('Built optimized TypeScript map, home, updates, worker and styles; no Node runtime on the Pi.');
  console.log(JSON.stringify(report));
} finally {
  await rm(stage, { recursive: true, force: true });
}
