import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { ObsController } from './obs-controller.js';

let config;
try { config = loadConfig(); }
catch (error) {
  console.error(`[config] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const controller = new ObsController({
  url: config.obs.url,
  password: config.obs.password,
  reconnectIntervalMs: config.obs.reconnectIntervalMs,
});
await controller.start();

const server = createHttpServer({ controller, remoteControlToken: config.remoteControlToken });
server.on('error', (error) => {
  console.error('[http] server error', error);
  process.exitCode = 1;
});
server.listen(config.port, config.host, () => {
  console.info(`[http] listening on http://${config.host}:${config.port}`);
  if (config.host === '127.0.0.1' || config.host === 'localhost') {
    console.info('[http] remote access: run `npm run tailscale:serve`');
  } else if (config.host === '0.0.0.0' || config.host === '::') {
    console.warn('[security] prefer HOST=127.0.0.1 with Tailscale Serve');
  }
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.info(`[shutdown] received ${signal}`);
  const force = setTimeout(() => process.exit(1), 5_000);
  force.unref();
  await new Promise((resolve) => server.close(resolve));
  await controller.stop();
  clearTimeout(force);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
