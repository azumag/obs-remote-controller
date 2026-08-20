import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ObsController } from '../src/obs-controller.js';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.requests = [];
    this.streamActive = false;
  }
  async connect() { return { obsWebSocketVersion: '5.test' }; }
  async disconnect() {}
  async call(type, data) {
    this.requests.push({ type, data });
    if (type === 'GetStreamStatus') return { outputActive: this.streamActive, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' };
    if (type === 'GetSceneList') {
      return { currentProgramSceneName: 'Main', scenes: [{ sceneName: 'Main' }, { sceneName: 'BRB' }] };
    }
    if (type === 'GetInputList') {
      return { inputs: [{ inputName: 'Mic/Aux', inputKind: 'coreaudio_input_capture' }, { inputName: 'Camera', inputKind: 'av_capture_input' }] };
    }
    if (type === 'GetInputMute') {
      if (data.inputName === 'Camera') throw new Error('Input has no audio');
      return { inputMuted: false };
    }
    if (type === 'StartStream') { this.streamActive = true; return {}; }
    if (type === 'StopStream') { this.streamActive = false; return {}; }
    return {};
  }
}

function setup() {
  const fake = new FakeClient();
  const controller = new ObsController({
    autoReconnect: false,
    logger: { info() {}, warn() {} },
    createClient: () => fake,
  });
  return { fake, controller };
}

test('collects stream, scene and audio state while excluding non-audio inputs', async () => {
  const { controller } = setup();
  await controller.connect();
  const state = await controller.getState();
  assert.equal(state.obsConnected, true);
  assert.equal(state.currentScene, 'Main');
  assert.deepEqual(state.scenes, [{ name: 'Main' }, { name: 'BRB' }]);
  assert.deepEqual(state.audioInputs, [{ name: 'Mic/Aux', kind: 'coreaudio_input_capture', muted: false }]);
});

test('stream operations are idempotent', async () => {
  const { fake, controller } = setup();
  await controller.connect();
  assert.deepEqual(await controller.setStreaming(false), { changed: false, active: false });
  assert.deepEqual(await controller.setStreaming(true), { changed: true, active: true });
  assert.equal(fake.requests.filter((item) => item.type === 'StartStream').length, 1);
  assert.deepEqual(await controller.setStreaming(true), { changed: false, active: true });
});

test('uses obs-websocket v5 scene and mute requests', async () => {
  const { fake, controller } = setup();
  await controller.connect();
  await controller.setCurrentScene('BRB');
  await controller.setInputMute('Mic/Aux', true);
  assert.deepEqual(fake.requests.slice(-2), [
    { type: 'SetCurrentProgramScene', data: { sceneName: 'BRB' } },
    { type: 'SetInputMute', data: { inputName: 'Mic/Aux', inputMuted: true } },
  ]);
});
