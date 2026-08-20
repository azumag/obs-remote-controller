import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Load the small dotenv subset used by this project. Existing variables win. */
export function loadEnvFile(filePath = process.env.ENV_FILE ?? '.env') {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    return { loaded: false, path: absolutePath };
  }

  for (const rawLine of readFileSync(absolutePath, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replaceAll('\\n', '\n')
          .replaceAll('\\r', '\r')
          .replaceAll('\\t', '\t')
          .replaceAll('\\"', '"')
          .replaceAll('\\\\', '\\');
      }
    }
    process.env[key] = value;
  }

  return { loaded: true, path: absolutePath };
}
