# sidecar-verify

Catch stale gzip and Brotli files before deploying a static site. Compare each
`.gz` or `.br` companion's decoded length and SHA-256 digest with its original,
regardless of modification times. Runs locally with **Node.js 22+ and no runtime
dependencies**. [中文说明](README.zh-CN.md).

A build can produce new HTML after its compression plugin has already run. The
plain page works, while a browser accepting gzip receives the old shell.
[One public incident reports exactly this sequence](https://github.com/berntpopp/kidney-genetics-db/issues/312).
Run this check on the final directory after prerendering, minification and config
injection, before uploading it to a server that serves precompressed files.

## Install and try

From a source checkout (the package is not published to npm):

```console
npm install --global .
sidecar-verify --version
node examples/demo.js
```

The self-cleaning demo creates two synthetic compressed companions, checks them,
then rewrites the original and checks again:

```text
Before a late rewrite: PASS (2 pairs)
After a late rewrite: FAIL (CONTENT_MISMATCH, CONTENT_MISMATCH)
```

You can run directly from the checkout without installing:

```console
node bin/sidecar-verify.js path/to/dist --json
```

## Check a deployment

```console
sidecar-verify path/to/dist
sidecar-verify path/to/dist --json
sidecar-verify path/to/dist --require gzip --require brotli
sidecar-verify path/to/dist --require gzip --extension .html --extension .js
sidecar-verify path/to/dist --max-bytes 536870912 --max-files 200000
```

An `app.js.gz` pairs with `app.js`; an `app.js.br` pairs with the same original.
Suffixes are case-sensitive. Existing companions are always checked. `--require`
additionally requires companions for `.html`, `.css`, `.js`, `.mjs`, `.json`,
`.svg`, and `.wasm` originals; repeated `--extension` replaces that selection.
There is no size-based exemption when companions are required.

The default limit is **256 MiB per original, compressed file and decoded stream**,
and **100,000 tree entries**, including directories. Processing is sequential,
using 64 KiB stream chunks rather than loading entire assets into memory.

| Exit | Meaning |
| --- | --- |
| 0 | At least one pair found; every inspected pair matches; no findings |
| 1 | Findings, including stale/corrupt files, missing companions or no pairs |
| 2 | Invalid arguments, unreadable root or tree entry limit; no complete report |

JSON reports have `schema_version: 1`, `complete`, `ok`, `entries`,
`checked_pairs`, `matched_pairs`, and `findings`. Each finding has `code`, `path`
(relative to the selected root), `encoding`, and a fixed explanatory message.
Input errors instead contain `complete: false` and an `error` object. A complete
report means every discovered candidate was attempted, including failed pairs.

| Finding | Action |
| --- | --- |
| CONTENT_MISMATCH | Recompress after the last source transformation |
| CORRUPT / TRAILING_DATA | Regenerate the damaged or noncanonical companion |
| ORPHAN | Remove or regenerate a companion whose original is absent |
| MISSING_SIDECAR | Generate the explicitly required encoding |
| BYTE_LIMIT | Review the asset and choose an appropriate larger limit |
| INPUT_CHANGED | Stop build writers and retry on a stable final directory |
| NON_REGULAR / NOT_REGULAR | Resolve symlinks or special files before checking |
| NESTED_SIDECAR | Avoid compressing already compressed companions |
| READ_ERROR | Check read permissions and file availability |
| NO_SIDECARS | Confirm the selected directory and compression build step |

## CI and JavaScript API

After building and installing this tool from a reviewed checkout or package:

```console
sidecar-verify dist --require gzip --json
```

```js
import { verifyDirectory } from 'sidecar-verify';
const report = await verifyDirectory('dist', { required: ['gzip', 'brotli'] });
if (!report.ok) process.exitCode = 1;
```

The API returns the same report as `--json`; invalid configuration or an incomplete
tree inventory throws `VerificationError` with a stable `code`.

## Scope, privacy and alternatives

- Read-only: no regeneration, deletion, uploads, telemetry or network access.
  File access times may change when your OS records reads.
- Reports include relative filenames, which may be sensitive. File contents and
  their digests are not printed.
- Use a stable build tree. Files are checked for metadata/identity changes, but
  this is not a sandbox for concurrently hostile filesystem modifications.
  Links and junctions discovered in the tree are reported and not intentionally
  traversed. OS-specific ancestor path races cannot be fully excluded.
- gzip and Brotli only. Concatenated gzip members are supported. A Brotli decoder
  must consume the entire file; ignored trailing bytes are a finding.
- No HTTP requests: this does not verify Content-Encoding, cache headers, CDN
  configuration, MIME types, zstd, or compressed-only deployments without originals.
- Node decoders allocate internal buffers. The stream byte limit bounds consumed
  file and emitted data, not total process memory or runtime. Directory enumeration
  initially loads each directory's names; use OS limits for untrusted trees.
- [static-compress](https://github.com/mqudsi/static-compress) and
  [gzip_static](https://github.com/rhpvorderman/gzip_static) generate compressed
  assets. Use them to create companions, then verify the final bytes here.
  `gzip -t` checks gzip stream integrity alone; it cannot find a valid stale copy.

## Development and cleanup

```console
npm ci --ignore-scripts
npm run check
npm test
npm run demo
npm pack --dry-run
```

Tests generate synthetic fixtures and remove them automatically. The CI matrix
checks Node 22/24 on Linux, macOS and Windows; workflow execution status is
visible in GitHub Actions. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md). No third-party runtime code or assets are bundled.

Uninstall a global installation with `npm uninstall --global sidecar-verify`.
If installed with a custom `--prefix`, use that same prefix when uninstalling.
Delete the checkout to remove source files. The checker creates no persistent data.

[MIT license](LICENSE). Initial version: **0.1.0**.
