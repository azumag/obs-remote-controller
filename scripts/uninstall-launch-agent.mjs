import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

if (process.platform !== 'darwin') {
  console.error('This uninstaller supports macOS launchd only.');
  process.exit(1);
}
const label = 'com.azumag.obs-remote-controller';
const plistPath = resolve(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const domain = `gui/${process.getuid()}`;
if (existsSync(plistPath)) {
  try { execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'inherit' }); } catch { /* stale plist */ }
  unlinkSync(plistPath);
}
console.log(`Uninstalled ${label}`);
