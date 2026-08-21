const layer = document.querySelector('#overlay-layer');
const text = document.querySelector('#overlay-text');

function render(state) {
  const fontSize = Number.isFinite(state?.fontSize) ? state.fontSize : 64;
  const color = typeof state?.color === 'string' ? state.color : '#ffffff';
  const position = ['top', 'center', 'bottom'].includes(state?.position) ? state.position : 'bottom';
  const animation = state?.animation === 'none' ? 'none' : 'fade';

  document.body.dataset.position = position;
  document.documentElement.style.setProperty('--overlay-font-size', `${fontSize}px`);
  document.documentElement.style.setProperty('--overlay-color', color);
  text.textContent = typeof state?.text === 'string' ? state.text : '';
  layer.className = [
    'overlay-layer',
    `animation-${animation}`,
    state?.background ? 'has-background' : '',
    state?.visible ? 'visible' : '',
  ].filter(Boolean).join(' ');
}

const events = new EventSource('/overlay/events');
events.addEventListener('state', (event) => {
  try { render(JSON.parse(event.data)); }
  catch { /* Keep the last valid overlay on malformed data. */ }
});

render({ visible: false });
