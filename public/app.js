const TOKEN_KEY = 'obs-remote-controller.token';
const POLL_INTERVAL_MS = 2_000;

const elements = {
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  errorBanner: document.querySelector('#error-banner'),
  streamStatus: document.querySelector('#stream-status'),
  streamDetail: document.querySelector('#stream-detail'),
  streamBadge: document.querySelector('#stream-live-badge'),
  streamButton: document.querySelector('#stream-button'),
  overlayForm: document.querySelector('#overlay-form'),
  overlayStatus: document.querySelector('#overlay-status'),
  overlayText: document.querySelector('#overlay-text'),
  overlayPosition: document.querySelector('#overlay-position'),
  overlayDuration: document.querySelector('#overlay-duration'),
  overlayAnimation: document.querySelector('#overlay-animation'),
  overlayColor: document.querySelector('#overlay-color'),
  overlayFontSize: document.querySelector('#overlay-font-size'),
  overlayFontSizeValue: document.querySelector('#overlay-font-size-value'),
  overlayBackground: document.querySelector('#overlay-background'),
  overlayShowButton: document.querySelector('#overlay-show-button'),
  overlayHideButton: document.querySelector('#overlay-hide-button'),
  sceneGrid: document.querySelector('#scene-grid'),
  sceneCount: document.querySelector('#scene-count'),
  audioList: document.querySelector('#audio-list'),
  audioCount: document.querySelector('#audio-count'),
  updatedAt: document.querySelector('#updated-at'),
  refreshButton: document.querySelector('#refresh-button'),
  reconnectButton: document.querySelector('#reconnect-button'),
  settingsButton: document.querySelector('#settings-button'),
  settingsDialog: document.querySelector('#settings-dialog'),
  settingsForm: document.querySelector('#settings-form'),
  settingsClose: document.querySelector('#settings-close'),
  tokenInput: document.querySelector('#token-input'),
  tokenDelete: document.querySelector('#token-delete'),
  confirmDialog: document.querySelector('#confirm-dialog'),
  confirmTitle: document.querySelector('#confirm-title'),
  confirmMessage: document.querySelector('#confirm-message'),
  confirmAccept: document.querySelector('#confirm-accept'),
};

let token = localStorage.getItem(TOKEN_KEY) ?? '';
let state = null;
let refreshPromise = null;
let busy = false;
let overlayDirty = false;

function showError(message) {
  elements.errorBanner.textContent = message;
  elements.errorBanner.hidden = false;
}

function clearError() {
  elements.errorBanner.hidden = true;
  elements.errorBanner.textContent = '';
}

function openSettings() {
  elements.tokenInput.value = token;
  if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
  queueMicrotask(() => elements.tokenInput.focus());
}

async function api(path, { method = 'GET', data } = {}) {
  if (!token) {
    openSettings();
    throw new Error('操作トークンを設定してください');
  }

  const headers = { Authorization: `Bearer ${token}` };
  const options = { method, headers };
  if (data !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(data);
  }

  const response = await fetch(path, options);
  let payload = {};
  try { payload = await response.json(); } catch { /* Preserve the HTTP status below. */ }

  if (!response.ok) {
    if (response.status === 401) openSettings();
    const error = new Error(payload?.error?.message || `HTTP ${response.status}`);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function empty(container, message) {
  const node = document.createElement('p');
  node.className = 'empty-state';
  node.textContent = message;
  container.replaceChildren(node);
}

function renderScenes(scenes, currentScene) {
  elements.sceneCount.textContent = String(scenes.length);
  if (scenes.length === 0) {
    empty(elements.sceneGrid, state?.obsConnected ? 'シーンがありません。' : 'OBSへ接続するとシーンが表示されます。');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const scene of scenes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `scene-button${scene.name === currentScene ? ' current' : ''}`;
    button.textContent = scene.name;
    button.dataset.sceneName = scene.name;
    button.disabled = busy || !state?.obsConnected || scene.name === currentScene;
    button.setAttribute('aria-pressed', String(scene.name === currentScene));
    fragment.append(button);
  }
  elements.sceneGrid.replaceChildren(fragment);
}

function renderAudio(inputs) {
  elements.audioCount.textContent = String(inputs.length);
  if (inputs.length === 0) {
    empty(elements.audioList, state?.obsConnected ? 'ミュート操作できる入力がありません。' : 'OBSへ接続すると音声入力が表示されます。');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const input of inputs) {
    const row = document.createElement('div');
    row.className = 'audio-row';

    const name = document.createElement('div');
    name.className = 'audio-name';
    name.textContent = input.name;
    if (input.kind) {
      const kind = document.createElement('span');
      kind.className = 'audio-kind';
      kind.textContent = input.kind;
      name.append(kind);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mute-button${input.muted ? ' muted' : ''}`;
    button.textContent = input.muted ? 'ミュート解除' : 'ミュート';
    button.dataset.inputName = input.name;
    button.dataset.nextMuted = String(!input.muted);
    button.disabled = busy || !state?.obsConnected;
    button.setAttribute('aria-pressed', String(input.muted));

    row.append(name, button);
    fragment.append(row);
  }
  elements.audioList.replaceChildren(fragment);
}

function renderOverlay(overlay) {
  const value = overlay ?? {
    visible: false,
    text: '',
    position: 'bottom',
    durationMs: 0,
    animation: 'fade',
    color: '#ffffff',
    fontSize: 64,
    background: true,
  };

  elements.overlayStatus.textContent = value.visible ? '表示中' : '非表示';
  elements.overlayStatus.className = `count-badge${value.visible ? ' overlay-visible' : ''}`;
  if (!overlayDirty) {
    elements.overlayText.value = value.text ?? '';
    elements.overlayPosition.value = value.position ?? 'bottom';
    elements.overlayDuration.value = String(value.durationMs ?? 0);
    elements.overlayAnimation.value = value.animation ?? 'fade';
    elements.overlayColor.value = value.color ?? '#ffffff';
    elements.overlayFontSize.value = String(value.fontSize ?? 64);
    elements.overlayBackground.checked = Boolean(value.background);
  }
  elements.overlayFontSizeValue.textContent = `${elements.overlayFontSize.value}px`;
  elements.overlayShowButton.disabled = busy;
  elements.overlayHideButton.disabled = busy || !value.visible;
}

function render(nextState = state) {
  state = nextState;
  const connected = Boolean(state?.obsConnected);
  elements.connectionDot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  elements.connectionLabel.textContent = connected
    ? 'OBS接続中'
    : state?.obsError
      ? `OBS未接続: ${state.obsError}`
      : 'OBS未接続';

  const live = Boolean(state?.stream?.active);
  elements.streamBadge.hidden = !live;
  elements.streamStatus.textContent = !connected ? 'OBS未接続' : live ? '配信中' : '配信停止中';
  elements.streamDetail.textContent = !connected
    ? 'OBSを起動し、WebSocket設定とパスワードを確認してください。'
    : live
      ? `配信時間 ${state.stream.timecode || '取得中'} / 現在シーン ${state.currentScene || '不明'}`
      : `現在シーン ${state.currentScene || '不明'}`;
  elements.streamButton.textContent = live ? '配信を停止' : '配信を開始';
  elements.streamButton.className = `primary-button${live ? ' stop' : ''}`;
  elements.streamButton.disabled = busy || !connected;

  renderOverlay(state?.overlay);
  renderScenes(state?.scenes ?? [], state?.currentScene ?? null);
  renderAudio(state?.audioInputs ?? []);

  elements.updatedAt.textContent = state?.updatedAt
    ? `更新 ${new Date(state.updatedAt).toLocaleTimeString('ja-JP')}`
    : '未更新';
  elements.refreshButton.disabled = busy;
  elements.reconnectButton.disabled = busy;
}

async function refresh({ reportError = false, force = false } = {}) {
  if (refreshPromise) {
    if (!force) return refreshPromise;
    try { await refreshPromise; } catch { /* Start a fresh request below. */ }
  }
  refreshPromise = (async () => {
    try {
      const nextState = await api('/api/state');
      clearError();
      render(nextState);
      return nextState;
    } catch (error) {
      if (reportError || error?.status !== 401) showError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function confirmAction({ title, message, destructive = false }) {
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmAccept.className = `primary-button compact${destructive ? ' stop' : ''}`;
  elements.confirmAccept.textContent = destructive ? '停止する' : '実行する';
  elements.confirmDialog.returnValue = '';
  elements.confirmDialog.showModal();
  return new Promise((resolve) => {
    elements.confirmDialog.addEventListener('close', () => resolve(elements.confirmDialog.returnValue === 'confirm'), { once: true });
  });
}

async function perform(action) {
  if (busy) return;
  busy = true;
  render();
  clearError();
  try {
    await action();
    await refresh({ reportError: true, force: true });
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
    render();
  }
}

async function performOverlayUpdate(data) {
  if (busy) return;
  busy = true;
  render();
  clearError();
  try {
    await api('/api/overlay', { method: 'PUT', data });
    await refresh({ reportError: true, force: true });
    overlayDirty = false;
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
    render();
  }
}

function overlayFormData() {
  return {
    text: elements.overlayText.value,
    visible: true,
    position: elements.overlayPosition.value,
    durationMs: Number(elements.overlayDuration.value),
    animation: elements.overlayAnimation.value,
    color: elements.overlayColor.value,
    fontSize: Number(elements.overlayFontSize.value),
    background: elements.overlayBackground.checked,
  };
}

elements.streamButton.addEventListener('click', async () => {
  const active = Boolean(state?.stream?.active);
  const accepted = await confirmAction({
    title: active ? '配信を停止しますか？' : '配信を開始しますか？',
    message: active
      ? '配信先への送信を停止します。OBS自体は起動したままです。'
      : 'OBSで設定済みの配信先へ送信を開始します。',
    destructive: active,
  });
  if (accepted) perform(() => api('/api/stream', { method: 'POST', data: { active: !active } }));
});

elements.overlayForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!elements.overlayForm.reportValidity()) return;
  performOverlayUpdate(overlayFormData());
});

elements.overlayHideButton.addEventListener('click', () => {
  perform(() => api('/api/overlay', { method: 'PUT', data: { visible: false } }));
});

elements.overlayForm.addEventListener('input', () => { overlayDirty = true; });
elements.overlayForm.addEventListener('change', () => { overlayDirty = true; });
elements.overlayFontSize.addEventListener('input', () => {
  elements.overlayFontSizeValue.textContent = `${elements.overlayFontSize.value}px`;
});

elements.sceneGrid.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-scene-name]');
  if (button) perform(() => api('/api/scene', { method: 'POST', data: { sceneName: button.dataset.sceneName } }));
});

elements.audioList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-input-name]');
  if (!button) return;
  perform(() => api('/api/input-mute', {
    method: 'POST',
    data: { inputName: button.dataset.inputName, muted: button.dataset.nextMuted === 'true' },
  }));
});

elements.refreshButton.addEventListener('click', () => refresh({ reportError: true }).catch(() => {}));
elements.reconnectButton.addEventListener('click', () => perform(() => api('/api/obs/reconnect', { method: 'POST', data: {} })));
elements.settingsButton.addEventListener('click', openSettings);
elements.settingsClose.addEventListener('click', () => elements.settingsDialog.close());

elements.settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const nextToken = elements.tokenInput.value.trim();
  if (nextToken.length < 32) {
    elements.tokenInput.setCustomValidity('32文字以上のトークンを入力してください');
    elements.tokenInput.reportValidity();
    return;
  }
  elements.tokenInput.setCustomValidity('');
  token = nextToken;
  localStorage.setItem(TOKEN_KEY, token);
  elements.settingsDialog.close();
  refresh({ reportError: true }).catch(() => {});
});

elements.tokenInput.addEventListener('input', () => elements.tokenInput.setCustomValidity(''));
elements.tokenDelete.addEventListener('click', () => {
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  elements.tokenInput.value = '';
  state = null;
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && token) refresh().catch(() => {});
});

render();
if (!token) openSettings();
else refresh({ reportError: true }).catch(() => {});
setInterval(() => {
  if (token && document.visibilityState === 'visible' && !busy) refresh().catch(() => {});
}, POLL_INTERVAL_MS);
