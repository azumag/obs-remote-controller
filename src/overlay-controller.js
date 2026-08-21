import { EventEmitter } from 'node:events';

export const DEFAULT_OVERLAY_STATE = Object.freeze({
  visible: false,
  text: '',
  position: 'bottom',
  fontSize: 64,
  color: '#ffffff',
  background: true,
  animation: 'fade',
  durationMs: 0,
});

export class OverlayController extends EventEmitter {
  constructor({ now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.hideTimer = null;
    this.state = {
      ...DEFAULT_OVERLAY_STATE,
      updatedAt: this.now().toISOString(),
    };
  }

  getState() {
    return { ...this.state };
  }

  update(patch) {
    this.state = {
      ...this.state,
      ...patch,
      updatedAt: this.now().toISOString(),
    };
    this.#scheduleAutoHide();
    const state = this.getState();
    this.emit('state', state);
    return state;
  }

  stop() {
    if (this.hideTimer) this.clearTimer(this.hideTimer);
    this.hideTimer = null;
    this.emit('close');
    this.removeAllListeners();
  }

  #scheduleAutoHide() {
    if (this.hideTimer) this.clearTimer(this.hideTimer);
    this.hideTimer = null;
    if (!this.state.visible || this.state.durationMs <= 0) return;

    this.hideTimer = this.setTimer(() => {
      this.hideTimer = null;
      if (!this.state.visible) return;
      this.state = {
        ...this.state,
        visible: false,
        updatedAt: this.now().toISOString(),
      };
      this.emit('state', this.getState());
    }, this.state.durationMs);
    this.hideTimer.unref?.();
  }
}
