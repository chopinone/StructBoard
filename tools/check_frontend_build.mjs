import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function inputs(root) {
  const files = ['package.json', 'package-lock.json', 'tools/check_frontend_build.mjs'];
  function walk(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name), name = relative(root, path).replaceAll('\\', '/');
      if (item.isDirectory() && item.name !== 'tests') walk(path);
      else if (item.isFile() && !name.endsWith('playwright.config.mjs')) files.push(name);
    }
  }
  walk(join(root, 'frontend'));
  return Object.fromEntries(files.sort().map(name => [name, digest(readFileSync(join(root, name)))]));
}
export function writeBuildRecord(root) {
  writeFileSync(join(root, 'ui/build.json'), JSON.stringify({ version: 1, inputs: inputs(root),
    bundle: digest(readFileSync(join(root, 'ui/shell.js'))) }, null, 2) + '\n');
}
export function checkBuild(root) {
  const record = JSON.parse(readFileSync(join(root, 'ui/build.json')));
  if (record.version !== 1 || JSON.stringify(record.inputs) !== JSON.stringify(inputs(root)) ||
      record.bundle !== digest(readFileSync(join(root, 'ui/shell.js')))) {
    throw Error('Vue bundle is stale. Run npm ci and npm run build:ui before packaging.');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkBuild(fileURLToPath(new URL('../', import.meta.url)));
  console.log('Vue source, lockfile and bundle match.');
}
