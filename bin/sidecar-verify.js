#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { verifyDirectory } from '../src/verify.js';

const help = `sidecar-verify 0.1.0
Usage: sidecar-verify DIRECTORY [--json] [--require gzip|brotli] [--extension .js]

Check gzip (.gz) and Brotli (.br) companions against their originals without writes.
--require and --extension can repeat. Default required suffix set:
.html .css .js .mjs .json .svg .wasm (only used with --require).
--max-bytes N  Per original, compressed file AND decoded stream (default 268435456)
--max-files N  Total directory entries, including directories (default 100000)
--json         Versioned machine-readable report
--help         Show help
--version      Show version
Exit: 0 matching pairs; 1 findings, including an empty tree; 2 input/usage error.
Reports include filenames. Run against a stable tree before deployment.`;

let json = process.argv.includes('--json');
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      require: { type: 'string', multiple: true },
      extension: { type: 'string', multiple: true },
      'max-bytes': { type: 'string' },
      'max-files': { type: 'string' },
    },
  });
  json = Boolean(values.json);
  if (values.help) console.log(help);
  else if (values.version) console.log('0.1.0');
  else {
    if (positionals.length !== 1) throw new Error('Provide exactly one deployment directory. Use --help for usage.');
    const report = await verifyDirectory(positionals[0], {
      required: values.require,
      extensions: values.extension,
      maxBytes: values['max-bytes'] === undefined ? undefined : Number(values['max-bytes']),
      maxFiles: values['max-files'] === undefined ? undefined : Number(values['max-files']),
    });
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`${report.ok ? 'PASS' : 'FAIL'}: ${report.matched_pairs}/${report.checked_pairs} pairs match; ${report.findings.length} findings`);
      for (const item of report.findings) {
        console.log(`  ${item.code} ${JSON.stringify(item.path)}${item.encoding ? ` (${item.encoding})` : ''}: ${item.message}`);
      }
    }
    process.exitCode = report.ok ? 0 : 1;
  }
} catch (error) {
  // Node argument parser messages may contain user input. Do not echo them.
  const message = error.name === 'VerificationError' ? error.message : 'Invalid input or arguments. Use --help for usage.';
  const result = { schema_version: 1, complete: false, error: { code: error.code?.startsWith('ERR_') ? 'USAGE' : error.code ?? 'USAGE', message } };
  if (json) console.log(JSON.stringify(result));
  else console.error(`${result.error.code}: ${message}`);
  process.exitCode = 2;
}
