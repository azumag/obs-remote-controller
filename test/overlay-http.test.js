import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpServer } from '../src/http-server.js';
import { OverlayController } from '../src/overlay-controller.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const auth = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, ...extra });

class FakeController {
  constructor() { this.connected = true; }
  async getState() {
    return {
      obsConnected: true,
      obsError: null,
      stream: { active: false, state: null, timecode: null },
      currentScene: 'Main',
      scenes: [],
      audioInputs: [],
      updatedAt: new Date(0).toISOString(),
    };
  }
}

async function withServer(run) {
  const overlayController = new OverlayController();
  const server = createHttpServer({
    controller: new FakeController(),
    overlayController,
    remoteControlToken: TOKEN,
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await run({ baseUrl: `http://127.0.0.1:${address.port}`, overlayController }); }
  finally {
    overlayController.stop();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('serves the OBS browser overlay without controller authentication', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/overlay/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /OBS Remote Overlay/u);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  });
});

test('requires authentication to update overlay and exposes it in state', async () => {
  await withServer(async ({ baseUrl }) => {
    assert.equal((await fetch(`${baseUrl}/api/overlay`)).status, 401);

    const update = await fetch(`${baseUrl}/api/overlay`, {
      method: 'PUT',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        text: 'お知らせ',
        visible: true,
        position: 'top',
        fontSize: 72,
        color: '#AABBCC',
        background: false,
        animation: 'none',
        durationMs: 0,
      }),
    });
    assert.equal(update.status, 200);
    const updated = (await update.json()).result;
    assert.equal(updated.text, 'お知らせ');
    assert.equal(updated.color, '#aabbcc');
    assert.equal(updated.visible, true);

    const state = await fetch(`${baseUrl}/api/state`, { headers: auth() });
    assert.equal((await state.json()).overlay.text, 'お知らせ');
  });
});

test('validates overlay style values', async () => {
  await withServer(async ({ baseUrl }) => {
    const invalid = await fetch(`${baseUrl}/api/overlay`, {
      method: 'PUT',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ position: 'left', fontSize: 900 }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_REQUEST');
  });
});

test('streams initial overlay state over SSE', async () => {
  await withServer(async ({ baseUrl }) => {
    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/overlay/events`, { signal: abort.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/u);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    while (!content.includes('"visible":false')) {
      const { value, done } = await reader.read();
      if (done) break;
      content += decoder.decode(value, { stream: true });
    }
    assert.match(content, /event: state/u);
    abort.abort();
    try { await reader.cancel(); } catch {}
  });
});
