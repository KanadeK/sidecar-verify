import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip } from 'node:zlib';

const codecs = { gzip: '.gz', brotli: '.br' };
const defaultExtensions = ['.html', '.css', '.js', '.mjs', '.json', '.svg', '.wasm'];
const messages = {
  READ_ERROR: 'Could not read a regular file.',
  NOT_REGULAR: 'Input is not a regular file; links are never intentionally followed.',
  BYTE_LIMIT: 'A compressed, original, or decoded file exceeds the byte limit.',
  INPUT_CHANGED: 'Input metadata or identity changed during verification; retry on a stable tree.',
  CORRUPT: 'Compressed data could not be fully decoded and validated.',
  TRAILING_DATA: 'The decoder did not consume the entire compressed file.',
};

export class VerificationError extends Error {
  constructor(code, message) {
    super(message ?? messages[code]);
    this.name = 'VerificationError';
    this.code = code;
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VerificationError('OPTIONS', `${label} must be a positive safe integer.`);
  }
  return value;
}

function settings(options) {
  const maxBytes = positiveInteger(options.maxBytes ?? 256 * 1024 * 1024, 'maxBytes');
  const maxFiles = positiveInteger(options.maxFiles ?? 100_000, 'maxFiles');
  const required = options.required ?? [];
  const extensions = options.extensions ?? defaultExtensions;
  if (!Array.isArray(required) || required.some((item) => !Object.hasOwn(codecs, item))) {
    throw new VerificationError('OPTIONS', 'required must contain only gzip or brotli.');
  }
  if (!Array.isArray(extensions) || extensions.length === 0 || extensions.some(
    (item) => typeof item !== 'string' || !/^\.[a-zA-Z0-9]+$/.test(item),
  )) {
    throw new VerificationError('OPTIONS', 'extensions must be nonempty simple suffixes such as .js.');
  }
  return { maxBytes, maxFiles, required: [...new Set(required)], extensions };
}

function sameIdentity(before, after) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => before[key] === after[key]);
}

async function digest(file, encoding, maxBytes) {
  let handle;
  try {
    const pathStat = await lstat(file);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new VerificationError('NOT_REGULAR');
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || !sameIdentity(pathStat, before)) throw new VerificationError('INPUT_CHANGED');
    if (before.size > maxBytes) throw new VerificationError('BYTE_LIMIT');
    const hash = createHash('sha256');
    let bytes = 0;
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) return callback(new VerificationError('BYTE_LIMIT'));
        hash.update(chunk);
        callback();
      },
    });
    const input = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    const streams = [input];
    const decoder = encoding === 'gzip' ? createGunzip({ chunkSize: 64 * 1024 })
      : encoding === 'brotli' ? createBrotliDecompress({ chunkSize: 64 * 1024 }) : null;
    if (decoder) streams.push(decoder);
    streams.push(sink);
    await pipeline(streams);
    if (decoder && decoder.bytesWritten !== before.size) throw new VerificationError('TRAILING_DATA');
    const after = await handle.stat();
    const current = await lstat(file);
    if (!sameIdentity(before, after) || !sameIdentity(before, current) || !current.isFile()) {
      throw new VerificationError('INPUT_CHANGED');
    }
    return { bytes, hash: hash.digest('hex'), identity: after };
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    if (encoding && (error.code?.startsWith('Z_') || error.code?.startsWith('ERR_'))) {
      throw new VerificationError('CORRUPT');
    }
    throw new VerificationError('READ_ERROR');
  } finally {
    await handle?.close();
  }
}

async function inventory(root, maxFiles) {
  const entries = new Map();
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const file = join(directory, child.name);
      const path = relative(root, file).split(sep).join('/');
      const type = child.isSymbolicLink() ? 'link' : child.isDirectory() ? 'dir' : child.isFile() ? 'file' : 'special';
      entries.set(path, type);
      if (entries.size > maxFiles) {
        throw new VerificationError('FILE_LIMIT', 'Directory entry limit exceeded; no complete report was produced.');
      }
      if (type === 'dir') pending.push(file);
    }
  }
  return new Map([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/** Verify a stable deployment tree. Does not write files or intentionally follow links. */
export async function verifyDirectory(directory, options = {}) {
  const config = settings(options);
  if (typeof directory !== 'string' || !directory) throw new VerificationError('OPTIONS', 'A directory is required.');
  const root = resolve(directory);
  let entries;
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VerificationError('ROOT', 'Root must be a directory, not a link.');
    entries = await inventory(root, config.maxFiles);
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError('ROOT', 'Could not enumerate the deployment directory.');
  }
  const report = {
    schema_version: 1,
    complete: true,
    entries: entries.size,
    checked_pairs: 0,
    matched_pairs: 0,
    findings: [],
  };
  const add = (code, path, encoding, message) => report.findings.push({ code, path, encoding, message });
  for (const [path, type] of entries) {
    if (type === 'link' || type === 'special') {
      add('NON_REGULAR', path, null, 'Link or special entry was not inspected.');
      continue;
    }
    if (type !== 'file') continue;
    const encoding = path.endsWith('.gz') ? 'gzip' : path.endsWith('.br') ? 'brotli' : null;
    if (!encoding) continue;
    const source = path.slice(0, -codecs[encoding].length);
    if (source.endsWith('.gz') || source.endsWith('.br')) {
      add('NESTED_SIDECAR', path, encoding, 'A compressed companion of another companion is outside the supported layout.');
      continue;
    }
    if (entries.get(source) !== 'file') {
      add('ORPHAN', path, encoding, 'No regular original exists at the companion path with its suffix removed.');
      continue;
    }
    report.checked_pairs++;
    try {
      const original = await digest(join(root, source), null, config.maxBytes);
      const decoded = await digest(join(root, path), encoding, config.maxBytes);
      const current = await lstat(join(root, source));
      if (!sameIdentity(original.identity, current) || !current.isFile()) throw new VerificationError('INPUT_CHANGED');
      if (original.bytes !== decoded.bytes || original.hash !== decoded.hash) {
        add('CONTENT_MISMATCH', path, encoding, 'Decoded bytes differ from the original. Rebuild this companion after all content transforms.');
      } else {
        report.matched_pairs++;
      }
    } catch (error) {
      const failure = error instanceof VerificationError ? error : new VerificationError('READ_ERROR');
      add(failure.code, path, encoding, failure.message);
    }
  }
  for (const [path, type] of entries) {
    if (type !== 'file' || path.endsWith('.gz') || path.endsWith('.br')) continue;
    if (!config.extensions.some((extension) => path.endsWith(extension))) continue;
    for (const encoding of config.required) {
      if (entries.get(path + codecs[encoding]) !== 'file') {
        add('MISSING_SIDECAR', path, encoding, 'A required compressed companion is missing.');
      }
    }
  }
  if (report.checked_pairs === 0 && report.findings.length === 0) {
    add('NO_SIDECARS', '.', null, 'No gzip or Brotli pairs were found. Check the selected directory.');
  }
  report.ok = report.findings.length === 0;
  return report;
}
