# Design and acceptance contract

Target user: a release engineer shipping identity, gzip and Brotli static assets.
Core flow: finish build → check final directory → fix findings → check again → deploy.
The checker never edits the build. Its failure statuses are directly usable in CI.

Acceptance: matching gzip/Brotli pass; a same-length stale copy with equal mtimes
fails; truncated data and bad gzip CRC fail; missing/orphan files fail; data limits
stop decompression; CLI exit codes and JSON remain stable; installed package runs
outside the source directory. An empty tree must never be mistaken for success.

Implementation: enumerate a bounded tree without intentional link traversal,
sort relative paths, stream each original and decoded companion through SHA-256,
compare digest and length, and recheck observed identity and metadata. Require
the decoder to consume the entire compressed file. All field/path arguments are
data; no shell commands are constructed from inputs.

Independent review found that Node's Brotli decoder can ignore trailing data.
An experiment confirmed fewer consumed bytes than input bytes while reporting
success. The implementation now checks `bytesWritten` and has a regression test.
No third-party implementation was copied; dependencies are Node built-ins only.
