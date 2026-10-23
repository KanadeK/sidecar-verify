# Contributing

Small, reproducible bug reports and focused changes are welcome. Check the
documented scope before proposing a feature. Use synthetic fixtures; never attach
production exports, private paths, tokens, or personal data to an issue.

## Development

```console
npm ci --ignore-scripts
npm run check
npm test
npm run demo
npm pack --dry-run
```

Add regression coverage for behavioral changes. Keep error messages actionable,
outputs deterministic, and runtime dependencies minimal. Document any output
schema changes and update CHANGELOG.md. Security concerns follow SECURITY.md.
The CI workflow only runs checks and builds; it never commits or pushes code.
