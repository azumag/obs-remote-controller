import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const OP = Object.freeze({ HELLO: 0, IDENTIFY: 1, IDENTIFIED: 2, EVENT: 5, REQUEST: 6, RESPONSE: 7 });
const OPEN = 1;

async function asText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  throw new TypeError('Unsupported OBS WebSocket message type');
}

function eventError(event) {
  if (event?.error instanceof Error) return event.error;
  if (typeof event?.message === 'string' && event.message) return new Error(event.message);
  return new Error('OBS WebSocket connection error');
}

function closeError(event) {
  const code = Number.isInteger(event?.code) ? event.code : 0;
  const suffix = typeof event?.reason === 'string' && event.reason ? `: ${event.reason}` : '';
  return new Error(`OBS WebSocket closed (code ${code}${suffix})`);
}

export function createAuthenticationString(password, salt, challenge) {
  const secret = createHash('sha256').update(`${password}${salt}`, 'utf8').digest('base64');
  return createHash('sha256').update(`${secret}${challenge}`, 'utf8').digest('base64');
}

export class ObsWebSocketRequestError extends Error {
  constructor(requestType, status = {}) {
    const comment = typeof status.comment === 'string' && status.comment ? `: ${status.comment}` : '';
    super(`OBS request ${requestType} failed (${status.code ?? 'unknown'}${comment})`);
    this.name = 'ObsWebSocketRequestError';
    this.requestType = requestType;
    this.code = status.code ?? null;
    this.comment = status.comment ?? null;
  }
}

/** Minimal obs-websocket v5 JSON client using Node.js 22's built-in WebSocket. */
export class ObsWebSocketClient extends EventEmitter {
  constructor({ WebSocketImpl = globalThis.WebSocket, handshakeTimeoutMs = 8_000, requestTimeoutMs = 10_000 } = {}) {
    super();
    this.WebSocketImpl = WebSocketImpl;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.identified = false;
    this.attempt = null;
    this.hello = null;
    this.pending = new Map();
    this.manualClose = false;
  }

  async connect(url, password = '', { rpcVersion = 1 } = {}) {
    if (typeof this.WebSocketImpl !== 'function') {
      throw new Error('WebSocket is unavailable. Node.js 22 or newer is required.');
    }
    if (this.socket) await this.disconnect();

    this.manualClose = false;
    this.identified = false;
    this.hello = null;

    const socket = new this.WebSocketImpl(url, 'obswebsocket.json');
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`OBS WebSocket handshake timed out after ${this.handshakeTimeoutMs} ms`);
        this.#rejectAttempt(error);
        try { socket.close(4000, 'Handshake timeout'); } catch { this.#handleClose(socket, { code: 4000, reason: 'Handshake timeout' }); }
      }, this.handshakeTimeoutMs);
      timer.unref?.();
      this.attempt = { socket, password, rpcVersion, timer, resolve, reject };
    });

    socket.addEventListener('message', (event) => {
      this.#handleMessage(socket, event.data).catch((error) => {
        this.emit('ConnectionError', error);
        this.#rejectAttempt(error);
        try { socket.close(4006, 'Message decode error'); } catch { this.#handleClose(socket, { code: 4006, reason: 'Message decode error' }); }
      });
    });
    socket.addEventListener('error', (event) => {
      const error = eventError(event);
      if (!this.manualClose) this.emit('ConnectionError', error);
      this.#rejectAttempt(error);
    });
    socket.addEventListener('close', (event) => this.#handleClose(socket, event));

    return result;
  }

  async disconnect() {
    const socket = this.socket;
    if (!socket) {
      this.identified = false;
      return;
    }
    this.manualClose = true;
    if (socket.readyState === 3) {
      this.#handleClose(socket, { code: 1000, reason: 'Client disconnect' });
      return;
    }

    await new Promise((resolve) => {
      let done = false;
      let timer;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        this.#handleClose(socket, { code: 1000, reason: 'Client disconnect timeout' });
        finish();
      }, 1_000);
      timer.unref?.();
      socket.addEventListener('close', finish, { once: true });
      try { socket.close(1000, 'Client disconnect'); } catch { this.#handleClose(socket, { code: 1000, reason: 'Client disconnect' }); finish(); }
    });
  }

  call(requestType, requestData) {
    if (!this.socket || !this.identified || this.socket.readyState !== OPEN) {
      return Promise.reject(new Error('OBS WebSocket is not identified'));
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS request ${requestType} timed out after ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { requestType, timer, resolve, reject });

      const data = { requestType, requestId };
      if (requestData !== undefined) data.requestData = requestData;
      try {
        this.socket.send(JSON.stringify({ op: OP.REQUEST, d: data }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  async #handleMessage(socket, rawData) {
    if (socket !== this.socket) return;
    const message = JSON.parse(await asText(rawData));
    if (!message || typeof message !== 'object' || !Number.isInteger(message.op)) {
      throw new Error('Malformed OBS WebSocket message');
    }

    if (message.op === OP.HELLO) this.#hello(socket, message.d ?? {});
    else if (message.op === OP.IDENTIFIED) this.#identified(socket, message.d ?? {});
    else if (message.op === OP.RESPONSE) this.#response(message.d ?? {});
    else if (message.op === OP.EVENT) this.emit('Event', message.d ?? {});
  }

  #hello(socket, hello) {
    const attempt = this.attempt;
    if (!attempt || attempt.socket !== socket) throw new Error('Unexpected OBS Hello message');

    const serverRpc = Number.isInteger(hello.rpcVersion) ? hello.rpcVersion : 1;
    const requestedRpc = Number.isInteger(attempt.rpcVersion) ? attempt.rpcVersion : 1;
    const data = { rpcVersion: Math.min(serverRpc, requestedRpc), eventSubscriptions: 0 };

    if (hello.authentication !== undefined) {
      const { salt, challenge } = hello.authentication ?? {};
      if (typeof salt !== 'string' || typeof challenge !== 'string') {
        throw new Error('Malformed OBS authentication challenge');
      }
      data.authentication = createAuthenticationString(attempt.password, salt, challenge);
    }

    this.hello = hello;
    socket.send(JSON.stringify({ op: OP.IDENTIFY, d: data }));
  }

  #identified(socket, identified) {
    const attempt = this.attempt;
    if (!attempt || attempt.socket !== socket) throw new Error('Unexpected OBS Identified message');
    clearTimeout(attempt.timer);
    this.attempt = null;
    this.identified = true;
    attempt.resolve({
      negotiatedRpcVersion: identified.negotiatedRpcVersion ?? null,
      obsWebSocketVersion: this.hello?.obsWebSocketVersion ?? null,
      obsStudioVersion: this.hello?.obsStudioVersion ?? null,
    });
  }

  #response(response) {
    const item = typeof response.requestId === 'string' ? this.pending.get(response.requestId) : null;
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(response.requestId);
    if (response.requestStatus?.result !== true) {
      item.reject(new ObsWebSocketRequestError(item.requestType, response.requestStatus));
    } else {
      item.resolve(response.responseData ?? {});
    }
  }

  #rejectAttempt(error) {
    if (!this.attempt) return;
    const attempt = this.attempt;
    this.attempt = null;
    clearTimeout(attempt.timer);
    attempt.reject(error);
  }

  #handleClose(socket, event) {
    if (socket !== this.socket) return;
    const error = closeError(event);
    const manual = this.manualClose;
    this.manualClose = false;
    this.socket = null;
    this.identified = false;
    this.hello = null;
    this.#rejectAttempt(error);
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    if (!manual) this.emit('ConnectionClosed', event);
  }
}
