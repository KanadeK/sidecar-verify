# Changelog

## 0.1.0

- Stream gzip and Brotli companions and compare decoded size/SHA-256 to originals.
- Diagnose stale, corrupt, orphan, nested, missing and non-regular files.
- Reject ignored trailing compressed data; detect observed metadata changes.
- Add bounded processing, JSON reports, strict exit codes and required encodings.
- Include a self-cleaning synthetic demo, regression tests and a CI matrix.

Limits: stable local trees, gzip/Brotli only, no HTTP/CDN configuration checks.
