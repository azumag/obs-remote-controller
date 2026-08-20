import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const destination = resolve(root, '.env');
if (existsSync(destination)) {
  console.log(`.env already exists: ${destination}`);
  console.log('Existing settings were not changed.');
  process.exit(0);
}

const token = randomBytes(32).toString('hex');
const content = readFileSync(resolve(root, '.env.example'), 'utf8')
  .replace('replace-with-a-long-random-token', token)
  .replace('replace-with-your-obs-websocket-password', 'CHANGE_ME');
writeFileSync(destination, content, { encoding: 'utf8', mode: 0o600 });
chmodSync(destination, 0o600);

console.log(`Created ${destination} with mode 0600.`);
console.log('1. Replace OBS_WEBSOCKET_PASSWORD=CHANGE_ME in .env.');
console.log('2. Run: npm start');
console.log('3. Run in another terminal: npm run tailscale:serve');
console.log('');
console.log(`REMOTE_CONTROL_TOKEN=${token}`);
console.log('Copy this token into the settings screen on your phone.');
