import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { prepareExtension } = require('./extension-tools.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function option(name, fallback) {
  const i = args.indexOf('--' + name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

const root = path.resolve(String(option('root', path.join(here, '..'))));
const src = path.resolve(String(option('src', path.join(root, 'extension'))));
const out = path.resolve(String(option('out', path.join(root, 'extension'))));
const keyOpt = option('key', null);

try {
  const info = prepareExtension({
    src,
    out,
    keyFile: keyOpt ? path.resolve(String(keyOpt)) : null,
    version: option('version', undefined),
    firefoxId: String(option('firefox-id', 'downloadx@local')),
    codebase: String(option('codebase', '')),
  });
  process.stdout.write(JSON.stringify(info) + '\n');
} catch (e) {
  process.stderr.write('prepare-extension: ' + e.message + '\n');
  process.exit(1);
}
