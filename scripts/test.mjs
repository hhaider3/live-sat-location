import { build } from 'esbuild';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const outdir = await mkdtemp(path.join(tmpdir(), 'earth-orbit-tests-'));
try {
  const tests = (await readdir('tests')).filter(f => f.endsWith('.test.ts'));
  await build({ entryPoints: tests.map(f => `tests/${f}`), outdir, bundle: true,
    platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, logLevel: 'warning' });
  const result = spawnSync(process.execPath, ['--test', ...tests.map(f => path.join(outdir, f.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { await rm(outdir, { recursive: true, force: true }); }
