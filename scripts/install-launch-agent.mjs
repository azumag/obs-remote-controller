import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('This installer supports macOS launchd only.');
  process.exit(1);
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (!existsSync(resolve(root, '.env'))) {
  console.error('.env is missing. Run `npm run setup` first.');
  process.exit(1);
}

const label = 'com.azumag.obs-remote-controller';
const agents = resolve(homedir(), 'Library', 'LaunchAgents');
const logs = resolve(homedir(), 'Library', 'Logs');
const plistPath = resolve(agents, `${label}.plist`);
const stdout = resolve(logs, 'obs-remote-controller.log');
const stderr = resolve(logs, 'obs-remote-controller.error.log');
const domain = `gui/${process.getuid()}`;
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

mkdirSync(agents, { recursive: true });
mkdirSync(logs, { recursive: true });
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>
<string>${xml(process.execPath)}</string>
<string>${xml(resolve(root, 'src', 'server.js'))}</string>
</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(stdout)}</string>
<key>StandardErrorPath</key><string>${xml(stderr)}</string>
</dict></plist>
`;
writeFileSync(plistPath, plist, { encoding: 'utf8', mode: 0o600 });
chmodSync(plistPath, 0o600);
try { execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' }); } catch { /* first install */ }
execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
execFileSync('launchctl', ['kickstart', '-k', `${domain}/${label}`], { stdio: 'inherit' });
console.log(`Installed and started ${label}`);
console.log(`plist: ${plistPath}`);
console.log(`stdout: ${stdout}`);
console.log(`stderr: ${stderr}`);
