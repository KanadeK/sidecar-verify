import { brotliCompressSync, gzipSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDirectory } from '../src/verify.js';

// Creates synthetic deploy files in a temporary folder and always cleans them up.
const directory = await mkdtemp(join(tmpdir(), 'sidecar-verify-demo-'));
try {
  const page = '<!doctype html><title>Example</title><p>Prerendered page</p>';
  await writeFile(join(directory, 'index.html'), page);
  await writeFile(join(directory, 'index.html.gz'), gzipSync(page));
  await writeFile(join(directory, 'index.html.br'), brotliCompressSync(page));
  const good = await verifyDirectory(directory, { required: ['gzip', 'brotli'] });
  console.log(`Before a late rewrite: ${good.ok ? 'PASS' : 'FAIL'} (${good.matched_pairs} pairs)`);
  await writeFile(join(directory, 'index.html'), page + '<p>Late change</p>');
  const stale = await verifyDirectory(directory);
  console.log(`After a late rewrite: ${stale.ok ? 'PASS' : 'FAIL'} (${stale.findings.map((item) => item.code).join(', ')})`);
  if (!good.ok || stale.findings.filter((item) => item.code === 'CONTENT_MISMATCH').length !== 2) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
