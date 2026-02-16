// ─────────────────────────────────────────────────────────────────────────────
// output.js  —  Chroma Key Overlay Output Window Logic
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// Read the session ID from the URL (?session=...) so this output window
// only communicates with its paired control panel, not with other sessions.
const SESSION_ID   = new URLSearchParams(location.search).get('session') || 'default';
const CHANNEL_NAME = 'reference-overlay-' + SESSION_ID;
const LS_KEY       = 'referenceOverlayState-' + SESSION_ID;

// DOM refs — standard lower-third structure
const body     = document.getElementById('output-body');
const ltWrap   = document.getElementById('lt-wrap');
const ltRoot   = document.getElementById('lt-root');
const ltAccent = document.getElementById('lt-accent');
const ltLogo   = document.getElementById('lt-logo');
const ltText   = document.getElementById('lt-text');
const ltLine1  = document.getElementById('lt-line1');
const ltLine2  = document.getElementById('lt-line2');

// DOM refs — custom template container
const ltCustomWrap = document.getElementById('lt-custom-wrap');
const ltCustom     = document.getElementById('lt-custom');

// DOM refs — ticker tape
const tickerWrap  = document.getElementById('ticker-wrap');
const tickerBar   = document.getElementById('ticker-bar');
const tickerBadge = document.getElementById('ticker-badge');
const tickerText  = document.getElementById('ticker-text');

// Tracks whether the custom template is active, so showOverlay knows which path to use
let usingCustomTemplate = false;
// Tracks the most recently applied settings so showOverlay can access them
let currentSettings = {};

// ── window.postMessage listener ───────────────────────────────────────────────
window.addEventListener('message', e => {
  if (e.data && typeof e.data === 'object' && e.data.action) {
    handleMessage(e.data);
  }
});

// ── BroadcastChannel listener ─────────────────────────────────────────────────
let channel = null;
try {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = e => handleMessage(e.data);
} catch (_) {}

// ── LocalStorage fallback listener ────────────────────────────────────────────
let lastTs = 0;
window.addEventListener('storage', e => {
  if (e.key === LS_KEY && e.newValue) {
    try {
      const msg = JSON.parse(e.newValue);
      if (msg._ts && msg._ts > lastTs) { lastTs = msg._ts; handleMessage(msg); }
    } catch (_) {}
  }
});

// ── DOMContentLoaded ──────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Label output window with session ID; hidden by default until Settings enables it
  const watermark = document.getElementById('session-watermark');
  if (watermark) {
    watermark.textContent    = '#' + SESSION_ID;
    watermark.style.display  = 'none';   // hidden until operator enables it in Settings
  }
  const titleEl = document.getElementById('output-title');
  if (titleEl) titleEl.textContent = 'Output — #' + SESSION_ID;

  applyInitialSettings();
  restoreLastState();
  initWebSocket();
});

// ── Message Handler ───────────────────────────────────────────────────────────
function handleMessage(msg) {
  if (!msg || !msg.action) return;
  switch (msg.action) {
    case 'show':
      if (msg.settings) applySettings(msg.settings);
      showOverlay(msg.data);
      break;
    case 'clear':
      hideOverlay();
      break;
    case 'settings':
      applySettings(msg.settings);
      break;
    case 'show-ticker':
      showTicker(msg.data);
      break;
    case 'clear-ticker':
      hideTicker();
      break;
  }
}

// ── Show / Hide ───────────────────────────────────────────────────────────────
function showOverlay(data) {
  if (!data) return;

  if (usingCustomTemplate) {
    // Substitute template variables and inject into custom container
    renderCustomTemplate(currentSettings, data);
    ltCustomWrap.classList.remove('visible');
    void ltCustomWrap.offsetWidth;   // force reflow so transition fires
    ltCustomWrap.classList.add('visible');
  } else {
    ltLine1.textContent   = data.line1 || '';
    ltLine2.textContent   = data.line2 || '';
    ltLine2.style.display = data.line2 ? '' : 'none';
    ltRoot.classList.remove('visible');
    void ltRoot.offsetWidth;
    ltRoot.classList.add('visible');
  }

  try {
    sessionStorage.setItem('overlayLive', JSON.stringify({ data, ts: Date.now() }));
  } catch (_) {}
}

function hideOverlay() {
  ltRoot.classList.remove('visible');
  if (ltCustomWrap) ltCustomWrap.classList.remove('visible');
  try { sessionStorage.removeItem('overlayLive'); } catch (_) {}
}

// ── Ticker Show / Hide ────────────────────────────────────────────────────────
function showTicker(data) {
  if (!data || !tickerWrap) return;

  // Apply colors
  tickerBar.style.background = data.bgColor  || '#cc0000';
  tickerBar.style.color      = data.textColor || '#ffffff';

  // Badge label
  tickerBadge.textContent = data.label || '⚠ ALERT';
  tickerBadge.style.color = data.textColor || '#ffffff';

  // Position (top / bottom)
  tickerWrap.classList.remove('pos-top');
  if (data.position === 'top') tickerWrap.classList.add('pos-top');

  // Set text content and restart scroll animation
  tickerText.classList.remove('running');
  tickerText.textContent = data.message || '';

  // Compute scroll duration: pixels of travel / speed (px/s)
  // Travel = viewport width (100vw, approx 1920) + text natural width
  void tickerText.offsetWidth; // force layout to get scrollWidth
  const textPx   = tickerText.scrollWidth;
  const totalPx  = window.innerWidth + textPx;
  const speed    = data.speed || 140; // px/s
  const duration = Math.max(4, totalPx / speed);
  tickerText.style.animationDuration = duration + 's';

  tickerText.classList.add('running');

  // Show the wrap
  tickerWrap.classList.add('visible');

  try {
    sessionStorage.setItem('tickerLive', JSON.stringify({ data, ts: Date.now() }));
  } catch (_) {}
}

function hideTicker() {
  if (!tickerWrap) return;
  tickerWrap.classList.remove('visible');
  // Stop animation after fade-out to save GPU
  setTimeout(() => {
    tickerText.classList.remove('running');
  }, 400);
  try { sessionStorage.removeItem('tickerLive'); } catch (_) {}
}

// ── Apply Settings ────────────────────────────────────────────────────────────
function applySettings(s) {
  if (!s) return;
  currentSettings = s;

  // ── Chroma key background ─────────────────────────────────────────────────
  body.classList.remove('chroma-blue', 'chroma-green', 'chroma-magenta', 'chroma-custom');
  const chromaMap = { '#0000ff': 'chroma-blue', '#00b140': 'chroma-green', '#ff00ff': 'chroma-magenta' };
  const cls = chromaMap[s.chroma?.toLowerCase()];
  if (cls) {
    body.classList.add(cls);
    body.style.background = '';
  } else if (s.chroma) {
    body.classList.add('chroma-custom');
    body.style.background = s.chroma;
  }

  // ── Animation ─────────────────────────────────────────────────────────────
  ltWrap.classList.remove('anim-fade', 'anim-slide', 'anim-none');
  ltWrap.classList.add('anim-' + (s.animation || 'fade'));

  // ── Lower third style ──────────────────────────────────────────────────────
  ltRoot.classList.remove('style-classic', 'style-accent', 'style-minimal', 'style-outline',
                          'style-gradient', 'style-solid', 'style-split', 'style-frosted');
  ltRoot.classList.add('style-' + (s.style || 'classic'));

  // ── Accent colour ─────────────────────────────────────────────────────────
  if (s.accentColor && ltAccent) {
    ltAccent.style.background = s.accentColor;
    document.documentElement.style.setProperty('--accent-color', s.accentColor);
  }

  // ── Position ──────────────────────────────────────────────────────────────
  ltWrap.classList.remove('pos-lower', 'pos-upper', 'pos-center');
  ltWrap.classList.add('pos-' + (s.position || 'lower'));
  if (ltCustomWrap) {
    ltCustomWrap.classList.remove('pos-lower', 'pos-upper', 'pos-center');
    ltCustomWrap.classList.add('pos-' + (s.position || 'lower'));
  }

  // ── Font ──────────────────────────────────────────────────────────────────
  if (s.font) {
    ltLine1.style.fontFamily = s.font;
    ltLine2.style.fontFamily = s.font;
    if (ltText)      ltText.style.fontFamily      = s.font;
    if (tickerText)  tickerText.style.fontFamily  = s.font;
    if (tickerBadge) tickerBadge.style.fontFamily = s.font;
  }

  // ── Text alignment ────────────────────────────────────────────────────────
  if (ltText) {
    ltText.classList.remove('align-left', 'align-center', 'align-right');
    ltText.classList.add('align-' + (s.textAlign || 'center'));
    ltText.style.textAlign = s.textAlign || 'center';
  }

  // ── Lower third background image ──────────────────────────────────────────
  if (s.ltBgImage) {
    const bgSizeMap = { stretch: '100% 100%', contain: 'contain', cover: 'cover' };
    ltRoot.style.backgroundImage    = `url('${s.ltBgImage}')`;
    ltRoot.style.backgroundSize     = bgSizeMap[s.ltBgSize] || 'cover';
    ltRoot.style.backgroundPosition = s.ltBgPosition || 'center center';
    ltRoot.style.backgroundRepeat   = 'no-repeat';
  } else {
    ltRoot.style.backgroundImage = '';
  }

  // ── Session watermark (operator reference — toggled via Settings) ─────────
  const watermark = document.getElementById('session-watermark');
  if (watermark) watermark.style.display = s.showSessionWatermark ? '' : 'none';

  // ── Min bar height (keeps bg image consistent on 1-line display) ──────────
  document.documentElement.style.setProperty('--lt-min-h', (s.ltMinHeight || 0) + 'px');

  // ── Logo ──────────────────────────────────────────────────────────────────
  // Logo max-height is controlled by the operator slider; --logo-max-h CSS var
  document.documentElement.style.setProperty('--logo-max-h', (s.logoSize || 110) + 'px');

  if (s.logoDataUrl) {
    ltLogo.src           = s.logoDataUrl;
    ltLogo.style.display = '';
    ltLogo.classList.remove('logo-left', 'logo-right');
    ltLogo.classList.add(s.logoPosition === 'right' ? 'logo-right' : 'logo-left');
    if (s.logoPosition === 'right') {
      ltRoot.appendChild(ltLogo);
    } else {
      ltRoot.insertBefore(ltLogo, ltText);
    }
  } else {
    ltLogo.style.display = 'none';
    ltLogo.src           = '';
  }

  // ── Custom template ────────────────────────────────────────────────────────
  const tmpl = s.customTemplate;
  usingCustomTemplate = !!(tmpl && tmpl.enabled && tmpl.html);

  if (usingCustomTemplate) {
    ltWrap.style.display       = 'none';
    ltCustomWrap.style.display = '';
    // Inject CSS
    let styleEl = document.getElementById('custom-template-style');
    if (!styleEl) {
      styleEl    = document.createElement('style');
      styleEl.id = 'custom-template-style';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = substituteVars(tmpl.css || '', s, null);
  } else {
    ltWrap.style.display       = '';
    ltCustomWrap.style.display = 'none';
    // Remove injected CSS if template was just turned off
    const styleEl = document.getElementById('custom-template-style');
    if (styleEl) styleEl.textContent = '';
  }
}

// ── Custom Template Rendering ─────────────────────────────────────────────────
function substituteVars(str, s, data) {
  return str
    .replace(/\{\{line1\}\}/g,       (data && data.line1)  ? escapeHtml(data.line1)  : '')
    .replace(/\{\{line2\}\}/g,       (data && data.line2)  ? escapeHtml(data.line2)  : '')
    .replace(/\{\{accentColor\}\}/g, s.accentColor  || '#C8A951')
    .replace(/\{\{font\}\}/g,        s.font          || 'system-ui')
    .replace(/\{\{logoUrl\}\}/g,     s.logoDataUrl   || '')
    .replace(/\{\{bgUrl\}\}/g,       s.ltBgImage     || '');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCustomTemplate(s, data) {
  if (!ltCustom || !s.customTemplate) return;
  const html = substituteVars(s.customTemplate.html || '', s, data);
  ltCustom.innerHTML = html;
}

// ── Apply settings from localStorage on load ──────────────────────────────────
function applyInitialSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('overlaySettings-' + SESSION_ID) || '{}');
    const ltBg  = localStorage.getItem('overlayLtBg-' + SESSION_ID);
    if (ltBg)  saved.ltBgImage   = ltBg;
    const logo  = localStorage.getItem('overlayLogo-' + SESSION_ID);
    if (logo)  saved.logoDataUrl = logo;
    if (Object.keys(saved).length) applySettings(saved);
  } catch (_) {}
}

// ── Restore live state after a page reload ────────────────────────────────────
function restoreLastState() {
  try {
    const live = JSON.parse(sessionStorage.getItem('overlayLive') || 'null');
    if (live && live.data) setTimeout(() => showOverlay(live.data), 100);
  } catch (_) {}

  try {
    const last = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (last && last.action === 'show' && last.data) {
      lastTs = last._ts || 0;
      applySettings(last.settings);
      setTimeout(() => showOverlay(last.data), 150);
    }
  } catch (_) {}

  // Restore ticker if it was live before reload
  try {
    const ticker = JSON.parse(sessionStorage.getItem('tickerLive') || 'null');
    if (ticker && ticker.data) setTimeout(() => showTicker(ticker.data), 200);
  } catch (_) {}
}

// ── WebSocket Client (server.js mode) ─────────────────────────────────────────
let ws = null;
const WS_PORT = parseInt(location.port) || 3333;

function initWebSocket() {
  if (location.protocol === 'file:') return;
  const url = `ws://${location.hostname}:${WS_PORT}?session=${SESSION_ID}&role=output`;
  try {
    ws = new WebSocket(url);
    ws.onmessage = e => { try { handleMessage(JSON.parse(e.data)); } catch (_) {} };
    ws.onclose   = () => { ws = null; setTimeout(initWebSocket, 5000); };
  } catch (_) {}
}
