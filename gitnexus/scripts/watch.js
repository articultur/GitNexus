#!/usr/bin/env node
/**
 * Watch script — incremental rebuild on source changes.
 *
 * Runs tsc --watch on both gitnexus-shared and gitnexus in parallel.
 * Import rewriting is NOT applied in watch mode; use `npm run build`
 * for a fully packaged dist before publishing.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHARED_ROOT = path.resolve(ROOT, '..', 'gitnexus-shared');

function watch(label, cwd) {
  const child = spawn('npx', ['tsc', '--watch', '--preserveWatchOutput'], {
    cwd,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));

  child.on('close', (code) => {
    if (code !== null) console.error(`[${label}] exited with code ${code}`);
  });

  return child;
}

console.log('[watch] starting watch mode for gitnexus-shared and gitnexus…');
watch('shared', SHARED_ROOT);
watch('gitnexus', ROOT);
