import { loadEnvFile } from './env.js';

function integer(name, rawValue, fallback, min, max) {
  const value = rawValue === undefined || rawValue === '' ? fallback : Number(rawValue);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function websocketUrl(rawValue) {
  let value;
  try {
    value = new URL(rawValue);
  } catch {
    throw new Error('OBS_WEBSOCKET_URL must be a valid ws:// or wss:// URL');
  }
  if (value.protocol !== 'ws:' && value.protocol !== 'wss:') {
    throw new Error('OBS_WEBSOCKET_URL must use ws:// or wss://');
  }
  return value.toString();
}

export function loadConfig() {
  const envFile = loadEnvFile();
  const remoteControlToken = process.env.REMOTE_CONTROL_TOKEN?.trim() ?? '';
  if (remoteControlToken.length < 32) {
    throw new Error('REMOTE_CONTROL_TOKEN must be at least 32 characters. Run `npm run setup`.');
  }

  return {
    envFile,
    host: process.env.HOST?.trim() || '127.0.0.1',
    port: integer('PORT', process.env.PORT, 8787, 1, 65_535),
    remoteControlToken,
    obs: {
      url: websocketUrl(process.env.OBS_WEBSOCKET_URL?.trim() || 'ws://127.0.0.1:4455'),
      password: process.env.OBS_WEBSOCKET_PASSWORD ?? '',
      reconnectIntervalMs: integer(
        'OBS_RECONNECT_INTERVAL_MS',
        process.env.OBS_RECONNECT_INTERVAL_MS,
        3000,
        500,
        60_000,
      ),
    },
  };
}
