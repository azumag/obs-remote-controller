import { EventEmitter } from 'node:events';
import { ObsWebSocketClient } from './obs-websocket-client.js';

export class ObsUnavailableError extends Error {
  constructor(message = 'OBS Studioに接続できていません') {
    super(message);
    this.name = 'ObsUnavailableError';
    this.code = 'OBS_UNAVAILABLE';
  }
}

function messageOf(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** Owns the only OBS connection. Browsers never connect to port 4455 directly. */
export class ObsController extends EventEmitter {
  constructor({
    url = 'ws://127.0.0.1:4455',
    password = '',
    reconnectIntervalMs = 3000,
    autoReconnect = true,
    logger = console,
    createClient = () => new ObsWebSocketClient(),
  } = {}) {
    super();
    this.url = url;
    this.password = password;
    this.reconnectIntervalMs = reconnectIntervalMs;
    this.autoReconnect = autoReconnect;
    this.logger = logger;
    this.client = createClient();
    this.connected = false;
    this.connecting = null;
    this.reconnectTimer = null;
    this.stopping = false;
    this.lastError = null;

    this.client.on('ConnectionClosed', () => {
      const changed = this.connected;
      this.connected = false;
      if (changed) {
        this.logger.warn?.('[obs] connection closed');
        this.emit('connection-changed', false);
      }
      this.#scheduleReconnect();
    });
    this.client.on('ConnectionError', (error) => {
      this.lastError = messageOf(error);
      this.logger.warn?.(`[obs] connection error: ${this.lastError}`);
    });
  }

  async start() {
    this.stopping = false;
    try { await this.connect(); } catch { /* UI must remain usable while OBS is closed. */ }
  }

  async stop() {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { await this.client.disconnect(); } catch (error) {
      this.logger.warn?.(`[obs] disconnect failed: ${messageOf(error)}`);
    }
    this.connected = false;
  }

  async connect() {
    if (this.stopping || this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const info = await this.client.connect(this.url, this.password, { rpcVersion: 1 });
        this.connected = true;
        this.lastError = null;
        this.logger.info?.(`[obs] connected (${info?.obsWebSocketVersion ?? 'unknown version'})`);
        this.emit('connection-changed', true);
      } catch (error) {
        this.connected = false;
        this.lastError = messageOf(error);
        if (!this.stopping) {
          this.logger.warn?.(`[obs] connection failed: ${this.lastError}`);
          this.#scheduleReconnect();
        }
        throw error;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  async reconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { await this.client.disconnect(); } catch { /* continue to a fresh attempt */ }
    this.connected = false;
    return this.connect();
  }

  #scheduleReconnect() {
    if (!this.autoReconnect || this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, this.reconnectIntervalMs);
    this.reconnectTimer.unref?.();
  }

  async #call(requestType, requestData) {
    if (!this.connected) {
      try { await this.connect(); } catch { throw new ObsUnavailableError(this.lastError || undefined); }
    }
    if (!this.connected) throw new ObsUnavailableError(this.lastError || undefined);

    try {
      return await this.client.call(requestType, requestData);
    } catch (error) {
      this.lastError = messageOf(error);
      throw error;
    }
  }

  disconnectedState() {
    return {
      obsConnected: false,
      obsError: this.lastError,
      stream: null,
      currentScene: null,
      scenes: [],
      audioInputs: [],
      updatedAt: new Date().toISOString(),
    };
  }

  async getState() {
    if (!this.connected) return this.disconnectedState();

    try {
      const [streamStatus, sceneList, inputList] = await Promise.all([
        this.#call('GetStreamStatus'),
        this.#call('GetSceneList'),
        this.#call('GetInputList'),
      ]);

      const muteResults = await Promise.allSettled(
        (inputList.inputs ?? []).map(async (input) => {
          if (typeof input?.inputName !== 'string') throw new Error('Input has no name');
          const mute = await this.#call('GetInputMute', { inputName: input.inputName });
          return {
            name: input.inputName,
            kind: typeof input.inputKind === 'string' ? input.inputKind : null,
            muted: Boolean(mute.inputMuted),
          };
        }),
      );

      return {
        obsConnected: true,
        obsError: null,
        stream: {
          active: Boolean(streamStatus.outputActive),
          state: streamStatus.outputState ?? null,
          timecode: streamStatus.outputTimecode ?? null,
        },
        currentScene: sceneList.currentProgramSceneName ?? null,
        scenes: (sceneList.scenes ?? [])
          .filter((scene) => typeof scene?.sceneName === 'string')
          .map((scene) => ({ name: scene.sceneName })),
        audioInputs: muteResults
          .filter((item) => item.status === 'fulfilled')
          .map((item) => item.value)
          .sort((a, b) => a.name.localeCompare(b.name, 'ja')),
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (!this.connected) return this.disconnectedState();
      throw error;
    }
  }

  async setStreaming(active) {
    const status = await this.#call('GetStreamStatus');
    if (Boolean(status.outputActive) === active) return { changed: false, active };
    await this.#call(active ? 'StartStream' : 'StopStream');
    return { changed: true, active };
  }

  async setCurrentScene(sceneName) {
    await this.#call('SetCurrentProgramScene', { sceneName });
    return { sceneName };
  }

  async setInputMute(inputName, muted) {
    await this.#call('SetInputMute', { inputName, inputMuted: muted });
    return { inputName, muted };
  }
}
