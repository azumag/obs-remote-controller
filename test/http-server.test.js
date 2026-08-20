import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpServer } from '../src/http-server.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

class FakeController {
  constructor() {
    this.connected = true;
    this.commands = [];
  }
  async getState() {
    return {
      obsConnected: true,
      obsError: null,
      stream: { active: false, state: null, timecode: null },
      currentScene: 'Main',
      scenes: [{ name: 'Main' }],
      audioInputs: [{ name: 'Mic/Aux', kind: null, muted: false }],
      updatedAt: new Date(0).toISOString(),
    };
  }
  async setStreaming(active) { this.commands.push({ type: 'stream', active }); return { changed: true, active }; }
  async setCurrentScene(sceneName) { this.commands.push({ type: 'scene', sceneName }); return { sceneName }; }
  async setInputMute(inputName, muted) { this.commands.push({ type: 'mute', inputName, muted }); return { inputName, muted }; }
  async reconnect() { this.commands.push({ type: 'reconnect' }); }
}

async function withServer(run) {
  const controller = new FakeController();
  const server = createHttpServer({ controller, remoteControlToken: TOKEN, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await run({ baseUrl: `http://127.0.0.1:${address.port}`, controller }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const auth = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, ...extra });

test('serves the controller UI and public health endpoint', async () => {
  await withServer(async ({ baseUrl }) => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /OBS Remote/u);
    assert.match(page.headers.get('content-security-policy'), /default-src/u);

    const health = await fetch(`${baseUrl}/api/health`);
    assert.deepEqual(await health.json(), { ok: true, obsConnected: true });
  });
});

test('requires the bearer token for state', async () => {
  await withServer(async ({ baseUrl }) => {
    assert.equal((await fetch(`${baseUrl}/api/state`)).status, 401);
    const response = await fetch(`${baseUrl}/api/state`, { headers: auth() });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).currentScene, 'Main');
  });
});

test('validates and forwards all initial control commands', async () => {
  await withServer(async ({ baseUrl, controller }) => {
    const requests = [
      fetch(`${baseUrl}/api/stream`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify({ active: true }) }),
      fetch(`${baseUrl}/api/scene`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sceneName: 'BRB' }) }),
      fetch(`${baseUrl}/api/input-mute`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify({ inputName: 'Mic/Aux', muted: true }) }),
    ];
    const responses = await Promise.all(requests);
    assert.ok(responses.every((response) => response.status === 200));
    assert.deepEqual(controller.commands, [
      { type: 'stream', active: true },
      { type: 'scene', sceneName: 'BRB' },
      { type: 'mute', inputName: 'Mic/Aux', muted: true },
    ]);
  });
});

test('rejects malformed command bodies', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/stream`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ active: 'yes' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  });
});
