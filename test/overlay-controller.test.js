import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_OVERLAY_STATE, OverlayController } from '../src/overlay-controller.js';

test('starts hidden with safe defaults and updates state', () => {
  const controller = new OverlayController({ now: () => new Date('2026-08-21T00:00:00.000Z') });
  assert.deepEqual(controller.getState(), {
    ...DEFAULT_OVERLAY_STATE,
    updatedAt: '2026-08-21T00:00:00.000Z',
  });

  const emitted = [];
  controller.on('state', (state) => emitted.push(state));
  const next = controller.update({ text: '配信中です', visible: true, position: 'center' });
  assert.equal(next.text, '配信中です');
  assert.equal(next.visible, true);
  assert.equal(next.position, 'center');
  assert.equal(emitted.length, 1);
  controller.stop();
});

test('automatically hides a visible timed overlay', async () => {
  const controller = new OverlayController({
    setTimer(fn, ms) {
      const timer = setTimeout(fn, ms);
      timer.unref = () => timer;
      return timer;
    },
  });
  const hidden = new Promise((resolve) => {
    controller.on('state', (state) => {
      if (!state.visible && state.text === '5秒表示') resolve(state);
    });
  });

  controller.update({ text: '5秒表示', visible: true, durationMs: 20 });
  const state = await hidden;
  assert.equal(state.visible, false);
  assert.equal(state.durationMs, 20);
  controller.stop();
});
