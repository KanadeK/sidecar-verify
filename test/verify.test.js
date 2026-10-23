import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { verifyDirectory } from '../src/verify.js';

const cli = fileURLToPath(new URL('../bin/sidecar-verify.js', import.meta.url));
async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-verify-test-'));
  try { await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function pair(directory, name, value, encoding = 'gzip', compressedValue = value) {
  await writeFile(join(directory, name), value);
  await writeFile(join(directory, name + (encoding === 'gzip' ? '.gz' : '.br')),
    encoding === 'gzip' ? gzipSync(compressedValue) : brotliCompressSync(compressedValue));
}
const codes = (report) => report.findings.map((finding) => finding.code);
const run = (directory, ...args) => spawnSync(process.execPath, [cli, directory, ...args], { encoding: 'utf8' });

for (const encoding of ['gzip', 'brotli']) {
  test(`${encoding}: accepts a matching companion`, () => fixture(async (directory) => {
    await pair(directory, 'app.js', 'console.log("good");', encoding);
    const report = await verifyDirectory(directory);
    assert.equal(report.ok, true);
    assert.equal(report.checked_pairs, 1);
    assert.equal(report.matched_pairs, 1);
  }));
  test(`${encoding}: detects valid compressed stale content`, () => fixture(async (directory) => {
    await pair(directory, 'index.html', '<p>prerendered</p>', encoding, '<div id="app"></div>');
    assert.deepEqual(codes(await verifyDirectory(directory)), ['CONTENT_MISMATCH']);
  }));
  test(`${encoding}: detects same-size mismatch even with equal timestamps`, () => fixture(async (directory) => {
    await pair(directory, 'app.js', 'new content', encoding, 'old content');
    const date = new Date('2025-01-01T00:00:00Z');
    await utimes(join(directory, 'app.js'), date, date);
    await utimes(join(directory, 'app.js' + (encoding === 'gzip' ? '.gz' : '.br')), date, date);
    assert.deepEqual(codes(await verifyDirectory(directory)), ['CONTENT_MISMATCH']);
  }));
  test(`${encoding}: rejects truncation`, () => fixture(async (directory) => {
    await pair(directory, 'app.js', 'some content', encoding);
    const path = join(directory, 'app.js' + (encoding === 'gzip' ? '.gz' : '.br'));
    const data = await readFile(path);
    await writeFile(path, data.subarray(0, Math.floor(data.length / 2)));
    assert.deepEqual(codes(await verifyDirectory(directory)), ['CORRUPT']);
  }));
  test(`${encoding}: stops an oversized decoded stream`, () => fixture(async (directory) => {
    await pair(directory, 'app.js', 'tiny', encoding, 'x'.repeat(1024 * 1024));
    assert.deepEqual(codes(await verifyDirectory(directory, { maxBytes: 256 })), ['BYTE_LIMIT']);
  }));
  test(`${encoding}: handles empty originals`, () => fixture(async (directory) => {
    await pair(directory, 'empty.js', '', encoding);
    assert.equal((await verifyDirectory(directory)).ok, true);
  }));
}

test('checks both encodings and nested paths with spaces and Unicode', () => fixture(async (directory) => {
  const nested = join(directory, 'assets 日本語');
  await mkdir(nested);
  const content = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  await pair(nested, 'a file.wasm', content, 'gzip');
  await pair(nested, 'a file.wasm', content, 'brotli');
  const report = await verifyDirectory(directory, { required: ['gzip', 'brotli'] });
  assert.equal(report.ok, true);
  assert.equal(report.matched_pairs, 2);
}));

test('rejects invalid gzip CRC even when decompressed content starts correctly', () => fixture(async (directory) => {
  await pair(directory, 'app.js', 'matching');
  const path = join(directory, 'app.js.gz');
  const compressed = await readFile(path);
  compressed[compressed.length - 8] ^= 0xff;
  await writeFile(path, compressed);
  assert.deepEqual(codes(await verifyDirectory(directory)), ['CORRUPT']);
}));

test('concatenated gzip members are compared as one representation', () => fixture(async (directory) => {
  await writeFile(join(directory, 'app.js'), 'part1part2');
  await writeFile(join(directory, 'app.js.gz'), Buffer.concat([gzipSync('part1'), gzipSync('part2')]));
  assert.equal((await verifyDirectory(directory)).ok, true);
}));

test('Brotli trailing data cannot silently pass content matching', () => fixture(async (directory) => {
  await writeFile(join(directory, 'app.js'), 'good');
  await writeFile(join(directory, 'app.js.br'), Buffer.concat([brotliCompressSync('good'), Buffer.from('junk')]));
  assert.deepEqual(codes(await verifyDirectory(directory)), ['TRAILING_DATA']);
}));

test('directory links are not traversed', () => fixture(async (directory) => {
  await mkdir(join(directory, 'real'));
  await pair(join(directory, 'real'), 'app.js', 'good');
  await symlink(join(directory, 'real'), join(directory, 'link'), 'junction');
  const report = await verifyDirectory(directory);
  assert.equal(report.checked_pairs, 1);
  assert.deepEqual(codes(report), ['NON_REGULAR']);
}));

test('finds orphan and nested companions without treating them as pairs', () => fixture(async (directory) => {
  await writeFile(join(directory, 'absent.js.gz'), gzipSync('old'));
  await writeFile(join(directory, 'absent.js.gz.br'), brotliCompressSync('old'));
  const report = await verifyDirectory(directory);
  assert.deepEqual(codes(report), ['ORPHAN', 'NESTED_SIDECAR']);
  assert.equal(report.checked_pairs, 0);
}));

test('required companions apply only to selected extensions', () => fixture(async (directory) => {
  await pair(directory, 'app.js', 'good');
  await writeFile(join(directory, 'notes.txt'), 'do not require');
  const report = await verifyDirectory(directory, { required: ['gzip', 'brotli'], extensions: ['.js'] });
  assert.deepEqual(codes(report), ['MISSING_SIDECAR']);
  assert.equal(report.findings[0].encoding, 'brotli');
}));

test('empty or wrong directories do not silently pass', () => fixture(async (directory) => {
  assert.deepEqual(codes(await verifyDirectory(directory)), ['NO_SIDECARS']);
  await writeFile(join(directory, 'app.js'), 'no companions');
  assert.deepEqual(codes(await verifyDirectory(directory, { required: ['gzip'] })), ['MISSING_SIDECAR']);
}));

test('rejects file and missing roots', () => fixture(async (directory) => {
  await writeFile(join(directory, 'file'), 'x');
  await assert.rejects(verifyDirectory(join(directory, 'file')), { code: 'ROOT' });
  await assert.rejects(verifyDirectory(join(directory, 'missing')), { code: 'ROOT' });
}));

test('enforces compressed and original file limits', () => fixture(async (directory) => {
  await pair(directory, 'app.js', 'x'.repeat(100));
  assert.deepEqual(codes(await verifyDirectory(directory, { maxBytes: 50 })), ['BYTE_LIMIT']);
  await pair(directory, 'app.js', 'x');
  assert.deepEqual(codes(await verifyDirectory(directory, { maxBytes: 10 })), ['BYTE_LIMIT']);
}));

test('enforces total directory entries, counting directories too', () => fixture(async (directory) => {
  await mkdir(join(directory, 'sub'));
  await pair(directory, 'app.js', 'x');
  await assert.rejects(verifyDirectory(directory, { maxFiles: 2 }), { code: 'FILE_LIMIT' });
}));

test('rejects unsafe or unsupported options', () => fixture(async (directory) => {
  for (const options of [
    { maxBytes: 0 }, { maxBytes: NaN }, { maxFiles: -1 }, { maxFiles: 1.5 },
    { required: ['zstd'] }, { required: 'gzip' }, { extensions: [] },
    { extensions: ['../js'] }, { extensions: '.js' },
  ]) await assert.rejects(verifyDirectory(directory, options), { code: 'OPTIONS' });
}));

test('links are reported, not silently skipped or followed', (context) => fixture(async (directory) => {
  const outside = join(directory, 'target.txt');
  await writeFile(outside, 'data');
  try { await symlink(outside, join(directory, 'linked.js')); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return context.skip('OS account cannot create symlinks');
    throw error;
  }
  await writeFile(join(directory, 'linked.js.gz'), gzipSync('data'));
  const report = await verifyDirectory(directory);
  assert.deepEqual(codes(report), ['NON_REGULAR', 'ORPHAN']);
}));

test('symlink roots are rejected', (context) => fixture(async (directory) => {
  await mkdir(join(directory, 'real'));
  try { await symlink(join(directory, 'real'), join(directory, 'link'), 'junction'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return context.skip('OS account cannot create symlinks');
    throw error;
  }
  await assert.rejects(verifyDirectory(join(directory, 'link')), { code: 'ROOT' });
}));

test('verification leaves source and companions byte-identical with original mtimes', () => fixture(async (directory) => {
  await pair(directory, 'app.js', 'unchanged');
  const paths = [join(directory, 'app.js'), join(directory, 'app.js.gz')];
  const snapshot = async () => Promise.all(paths.map(async (path) => ({
    hash: createHash('sha256').update(await readFile(path)).digest('hex'), mtime: (await stat(path)).mtimeMs,
  })));
  const before = await snapshot();
  assert.equal((await verifyDirectory(directory)).ok, true);
  assert.deepEqual(await snapshot(), before);
}));

test('CLI provides JSON and stable pass/fail/input exit codes', () => fixture(async (directory) => {
  await pair(directory, 'app.js', 'good');
  const good = run(directory, '--json');
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).ok, true);
  await writeFile(join(directory, 'app.js'), 'new');
  const bad = run(directory, '--json');
  assert.equal(bad.status, 1, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).findings[0].code, 'CONTENT_MISMATCH');
  const missing = run(join(directory, 'missing'), '--json');
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).complete, false);
}));

test('CLI protects diagnostic text and handles usage, version and help', () => fixture(async (directory) => {
  const unknown = run(directory, '--json', '--secret-never-echo=123');
  assert.equal(unknown.status, 2);
  assert.ok(!unknown.stdout.includes('secret-never-echo'));
  const required = run(directory, '--json', '--require', 'unknown');
  assert.equal(required.status, 2);
  assert.equal(JSON.parse(required.stdout).error.code, 'OPTIONS');
  assert.match(run('--help').stdout, /Usage:/);
  assert.equal(run('--version').stdout.trim(), '0.1.0');
  assert.equal(run(directory, '--max-bytes', 'Infinity').status, 2);
}));

test('text reports quote filenames containing terminal control characters', async (context) => {
  if (process.platform === 'win32') return context.skip('Windows disallows newline filenames');
  await fixture(async (directory) => {
    await writeFile(join(directory, 'bad\nname.gz'), 'x');
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes('"bad\\nname.gz"'));
  });
});
