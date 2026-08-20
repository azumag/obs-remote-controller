import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../src/env.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(root);
loadEnvFile();

const mode = process.argv[2];
if (mode !== 'on' && mode !== 'off') {
  console.error('Usage: node scripts/tailscale-serve.mjs <on|off>');
  process.exit(2);
}

function findBinary() {
  const candidates = [
    process.env.TAILSCALE_BIN,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ].filter(Boolean);
  try {
    const path = execFileSync('sh', ['-lc', 'command -v tailscale'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (path) candidates.unshift(path);
  } catch { /* Common app paths below are still checked. */ }
  return [...new Set(candidates)].find((path) => existsSync(path));
}

function port(name, raw, fallback) {
  const value = Number(raw || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

const binary = findBinary();
if (!binary) {
  console.error('Tailscale CLI was not found. Set TAILSCALE_BIN in .env.');
  process.exit(1);
}
const host = process.env.HOST?.trim() || '127.0.0.1';
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.error('Tailscale Serve mode requires HOST=127.0.0.1 (or localhost).');
  process.exit(1);
}

const appPort = port('PORT', process.env.PORT, 8787);
const httpsPort = port('TAILSCALE_HTTPS_PORT', process.env.TAILSCALE_HTTPS_PORT, 8443);
const args = mode === 'on'
  ? ['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${appPort}`]
  : ['serve', `--https=${httpsPort}`, 'off'];
console.log(`Running: ${binary} ${args.join(' ')}`);
const result = spawnSync(binary, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
