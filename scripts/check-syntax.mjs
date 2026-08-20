import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const files = [];
function collect(directory) {
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) collect(path);
    else if (['.js', '.mjs'].includes(extname(path))) files.push(path);
  }
}
for (const directory of ['src', 'public', 'scripts', 'test']) collect(resolve(root, directory));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax OK: ${files.length} files`);
