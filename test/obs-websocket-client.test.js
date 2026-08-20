import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAuthenticationString,
  ObsWebSocketClient,
  ObsWebSocketRequestError,
} from '../src/obs-websocket-client.js';

class FakeWebSocket {
  static instances = [];

  constructor(url, protocol) {
    this.url = url;
    this.protocol = protocol;
    this.readyState = 0;
    this.binaryType = '';
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) ?? [];
    entries.push({ listener, once: Boolean(options.once) });
    this.listeners.set(type, entries);
  }

  send(raw) {
    if (this.readyState !== 1) throw new Error('Socket is not open');
    this.sent.push(JSON.parse(raw));
  }

  open() {
    this.readyState = 1;
    this.emit('open', {});
  }

  receive(value) {
    this.emit('message', { data: JSON.stringify(value) });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', { code, reason, wasClean: true }));
  }

  emit(type, event) {
    const entries = [...(this.listeners.get(type) ?? [])];
    this.listeners.set(type, entries.filter((entry) => !entry.once));
    for (const entry of entries) entry.listener(event);
  }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function client() {
  FakeWebSocket.instances = [];
  return new ObsWebSocketClient({
    WebSocketImpl: FakeWebSocket,
    handshakeTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  });
}

async function identify(instance, authenticated = false) {
  const connecting = instance.connect('ws://127.0.0.1:4455', 'supersecretpassword', { rpcVersion: 1 });
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  socket.receive({
    op: 0,
    d: {
      obsStudioVersion: '32.2.1',
      obsWebSocketVersion: '5.6.0',
      rpcVersion: 1,
      ...(authenticated
        ? {
            authentication: {
              salt: 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=',
              challenge: '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=',
            },
          }
        : {}),
    },
  });
  await nextTurn();
  socket.receive({ op: 2, d: { negotiatedRpcVersion: 1 } });
  return { socket, info: await connecting };
}

test('implements the obs-websocket v5 SHA-256 challenge calculation', () => {
  assert.equal(
    createAuthenticationString(
      'supersecretpassword',
      'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=',
      '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=',
    ),
    '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=',
  );
});

test('identifies and resolves successful requests', async () => {
  const instance = client();
  const { socket, info } = await identify(instance, true);

  assert.equal(info.obsStudioVersion, '32.2.1');
  assert.equal(info.obsWebSocketVersion, '5.6.0');
  assert.deepEqual(socket.sent[0], {
    op: 1,
    d: {
      rpcVersion: 1,
      eventSubscriptions: 0,
      authentication: '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=',
    },
  });

  const response = instance.call('GetStreamStatus');
  const request = socket.sent.at(-1);
  assert.equal(request.op, 6);
  assert.equal(request.d.requestType, 'GetStreamStatus');
  socket.receive({
    op: 7,
    d: {
      requestId: request.d.requestId,
      requestStatus: { result: true, code: 100 },
      responseData: { outputActive: true },
    },
  });
  assert.deepEqual(await response, { outputActive: true });
  await instance.disconnect();
});

test('returns typed request errors from OBS', async () => {
  const instance = client();
  const { socket } = await identify(instance);
  const response = instance.call('SetCurrentProgramScene', { sceneName: 'Missing' });
  const request = socket.sent.at(-1);
  socket.receive({
    op: 7,
    d: {
      requestId: request.d.requestId,
      requestStatus: { result: false, code: 600, comment: 'No source was found' },
    },
  });
  await assert.rejects(response, (error) => {
    assert.ok(error instanceof ObsWebSocketRequestError);
    assert.equal(error.code, 600);
    assert.match(error.message, /No source was found/u);
    return true;
  });
  await instance.disconnect();
});

test('rejects pending requests after an unexpected close', async () => {
  const instance = client();
  const { socket } = await identify(instance);
  const response = instance.call('GetSceneList');
  socket.close(1006, 'Connection lost');
  await assert.rejects(response, /Connection lost/u);
});
