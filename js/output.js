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
let wsConnected = false;
let statePollTimer = null;
let lastStateUpdatedAt = 0;

const FONT_FALLBACK_STACK = "'Noto Sans Devanagari', 'Noto Sans Tamil', 'Noto Sans Telugu', 'Noto Sans Malayalam', 'Noto Sans Kannada', sans-serif";
const DEFAULT_TEXT_EFFECTS = {
  line1: { fontWeight: 700, italic: false, fontScale: 1, useCustomColor: false, fontColor: '#ffffff', shadowColor: '#000000', shadowAngle: 120, shadowDepth: 6, shadowBlur: 8, shadowOpacity: 0.85, strokeColor: '#000000', strokeWidth: 0 },
  line2: { fontWeight: 400, italic: false, fontScale: 1, useCustomColor: false, fontColor: '#ffffff', shadowColor: '#000000', shadowAngle: 120, shadowDepth: 4, shadowBlur: 6, shadowOpacity: 0.75, strokeColor: '#000000', strokeWidth: 0 },
};

function resolvedFontFamily(fontValue) {
  const raw = (fontValue || '').trim() || "'Cinzel', serif";
  return raw.includes('Noto Sans')
    ? `${raw}, sans-serif`
    : `${raw}, ${FONT_FALLBACK_STACK}`;
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(0,0,0,${Math.max(0, Math.min(1, alpha))})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r},${g},${b},${a})`;
}


const INLINE_LOWER_THIRD_STYLES = new Set(['inline-duo', 'inline-chip', 'inline-glass']);
const LOWER_THIRD_STYLE_CLASSNAMES = [
  'style-classic', 'style-accent', 'style-minimal', 'style-outline',
  'style-gradient', 'style-scripture', 'style-scripture-panel',
  'style-solid', 'style-split', 'style-frosted',
  'style-inline-duo', 'style-inline-chip', 'style-inline-glass',
];
const LOWER_THIRD_BACKGROUND_MODE = Object.freeze({
  classic: 'custom-solid',
  accent: 'transparent',
  minimal: 'transparent',
  outline: 'transparent',
  gradient: 'custom-gradient',
  scripture: 'custom-gradient',
  'scripture-panel': 'custom-solid',
  solid: 'style-defined',
  split: 'custom-solid',
  frosted: 'custom-solid',
  'inline-duo': 'custom-solid',
  'inline-chip': 'custom-solid',
  'inline-glass': 'custom-gradient',
});

function getLowerThirdBackgroundMode(style) {
  return LOWER_THIRD_BACKGROUND_MODE[style] || 'custom-solid';
}

function isInlineLowerThirdStyle(style) {
  return INLINE_LOWER_THIRD_STYLES.has(style);
}

function applyStyleAwareLowerThirdBackground(ltTextEl, settings) {
  if (!ltTextEl || !settings) return;
  const style = settings.style || 'gradient';
  const bgColor = settings.ltBgColor || '#000000';
  const bgOpacity = Math.max(0, Math.min(1, parseFloat(settings.ltBgOpacity ?? 0.88)));
  const mode = getLowerThirdBackgroundMode(style);

  ltTextEl.style.background = '';

  if (mode === 'transparent') {
    ltTextEl.style.background = 'transparent';
    return;
  }

  if (mode === 'custom-gradient') {
    const start = hexToRgba(bgColor, Math.max(0, Math.min(1, bgOpacity * 1.05)));
    const mid = hexToRgba(bgColor, Math.max(0, Math.min(1, bgOpacity * 0.72)));
    const end = hexToRgba(bgColor, 0);
    ltTextEl.style.background = `linear-gradient(90deg, ${start} 0%, ${mid} 62%, ${end} 100%)`;
    return;
  }

  if (mode === 'custom-solid') {
    ltTextEl.style.background = hexToRgba(bgColor, bgOpacity);
    return;
  }

  // style-defined: preserve CSS-defined background for the selected style.
}

function getLineTextEffect(s, key) {
  return { ...DEFAULT_TEXT_EFFECTS[key], ...(s?.textEffects?.[key] || {}) };
}

function applyLineEffectToEl(el, effect) {
  if (!el || !effect) return;
  el.style.fontWeight = String(effect.fontWeight || '');
  el.style.fontStyle = effect.italic ? 'italic' : '';
  el.style.color = effect.useCustomColor ? (effect.fontColor || '#ffffff') : '';
  const depth = Math.max(0, parseFloat(effect.shadowDepth) || 0);
  const angle = ((parseFloat(effect.shadowAngle) || 0) % 360) * (Math.PI / 180);
  const blur = Math.max(0, parseFloat(effect.shadowBlur) || 0);
  const opacity = Math.max(0, Math.min(1, parseFloat(effect.shadowOpacity) || 0));
  const x = Math.cos(angle) * depth;
  const y = Math.sin(angle) * depth;
  const shadowColor = hexToRgba(effect.shadowColor, opacity);
  el.style.textShadow = (depth > 0 || blur > 0)
    ? `${x.toFixed(1)}px ${y.toFixed(1)}px ${blur.toFixed(1)}px ${shadowColor}`
    : 'none';
  const strokeWidth = Math.max(0, parseFloat(effect.strokeWidth) || 0);
  el.style.webkitTextStroke = strokeWidth > 0
    ? `${strokeWidth.toFixed(1)}px ${effect.strokeColor || '#000000'}`
    : '0px transparent';
}

function applyLineTextEffects(s) {
  const l1 = getLineTextEffect(s, 'line1');
  const l2 = getLineTextEffect(s, 'line2');
  applyLineEffectToEl(ltLine1, l1);
  applyLineEffectToEl(ltLine2, l2);

  if (ltLine1) {
    ltLine1.style.fontSize = '';
    const base = parseFloat(getComputedStyle(ltLine1).fontSize) || 28;
    const scale = Math.max(0.3, parseFloat(l1.fontScale) || 1);
    ltLine1.style.fontSize = `${(base * scale).toFixed(1)}px`;
  }
  if (ltLine2) {
    ltLine2.style.fontSize = '';
    const base = parseFloat(getComputedStyle(ltLine2).fontSize) || 18;
    const scale = Math.max(0.3, parseFloat(l2.fontScale) || 1);
    ltLine2.style.fontSize = `${(base * scale).toFixed(1)}px`;
  }
}

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
  startStatePolling();
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
    if (!data.line2) {
      ltLine2.style.display = 'none';
    } else {
      const inlineStyle = isInlineLowerThirdStyle(currentSettings?.style || 'gradient');
      const multiline = !!currentSettings?.line2Multiline && !inlineStyle;
      ltLine2.style.display = multiline ? '-webkit-box' : 'block';
    }
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
  tickerBadge.textContent = data.label || 'INFO';
  tickerBadge.style.color = data.textColor || '#ffffff';

  const barHeight = Math.max(24, Math.min(140, parseInt(data.barHeight || 68, 10)));
  const textSize = Math.max(12, Math.min(72, parseInt(data.textSize || 28, 10)));
  const badgeSize = Math.max(10, Math.min(64, parseInt(data.badgeSize || 22, 10)));
  tickerBar.style.height = `${barHeight}px`;
  tickerText.style.fontSize = `${textSize}px`;
  tickerBadge.style.fontSize = `${badgeSize}px`;

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

  // ── Chroma key / transparent background ───────────────────────────────────
  body.classList.remove('chroma-blue', 'chroma-green', 'chroma-magenta', 'chroma-custom', 'chroma-transparent');
  body.style.background = '';
  if (s.chroma === 'transparent') {
    body.classList.add('chroma-transparent');
  } else {
    const chromaMap = { '#0000ff': 'chroma-blue', '#00b140': 'chroma-green', '#ff00ff': 'chroma-magenta' };
    const cls = chromaMap[s.chroma?.toLowerCase()];
    if (cls) {
      body.classList.add(cls);
    } else if (s.chroma) {
      body.classList.add('chroma-custom');
      body.style.background = s.chroma;
    }
  }

  // ── Animation ─────────────────────────────────────────────────────────────
  ltWrap.classList.remove('anim-fade', 'anim-slide', 'anim-none');
  ltWrap.classList.add('anim-' + (s.animation || 'fade'));

  // ── Lower third style ──────────────────────────────────────────────────────
  ltRoot.classList.remove(...LOWER_THIRD_STYLE_CLASSNAMES);
  ltRoot.classList.add('style-' + (s.style || 'gradient'));

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

  // ── Fonts ─────────────────────────────────────────────────────────────────
  const line1Font = resolvedFontFamily(s.line1Font || s.font);
  const line2Font = resolvedFontFamily(s.line2Font || s.line1Font || s.font);
  ltLine1.style.fontFamily = line1Font;
  ltLine2.style.fontFamily = line2Font;
  if (ltText)      ltText.style.fontFamily      = line1Font;
  if (tickerText)  tickerText.style.fontFamily  = line1Font;
  if (tickerBadge) tickerBadge.style.fontFamily = line1Font;

  // ── Text alignment ────────────────────────────────────────────────────────
  if (ltText) {
    ltText.classList.remove('align-left', 'align-center', 'align-right');
    ltText.classList.add('align-' + (s.textAlign || 'left'));
    ltText.style.textAlign = s.textAlign || 'left';
  }
  applyLineTextEffects(s);

  if (ltText) {
    applyStyleAwareLowerThirdBackground(ltText, s);
  }
  const ltWidth = Math.max(40, Math.min(100, parseInt(s.ltWidth || 100, 10)));
  if (ltRoot) {
    ltRoot.style.width = `${ltWidth}%`;
    ltRoot.style.maxWidth = '100%';
  }
  if (ltLine2) {
    const inlineStyle = isInlineLowerThirdStyle(s.style || 'gradient');
    const multiline = !!s.line2Multiline && !inlineStyle;
    const maxLines = Math.max(1, Math.min(6, parseInt(s.line2MaxLines || 2, 10)));
    const hasLine2 = !!(ltLine2.textContent || '').trim();
    ltLine2.style.whiteSpace = multiline ? 'normal' : 'nowrap';
    ltLine2.style.overflow = 'hidden';
    ltLine2.style.textOverflow = multiline ? 'clip' : 'ellipsis';
    ltLine2.style.display = !hasLine2 ? 'none' : (multiline ? '-webkit-box' : 'block');
    ltLine2.style.webkitBoxOrient = multiline ? 'vertical' : '';
    ltLine2.style.webkitLineClamp = multiline ? String(maxLines) : '';
    ltLine2.style.lineClamp = multiline ? String(maxLines) : '';
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
  const line1Font = resolvedFontFamily(s.line1Font || s.font);
  const line2Font = resolvedFontFamily(s.line2Font || s.line1Font || s.font);
  return str
    .replace(/\{\{line1\}\}/g,       (data && data.line1)  ? escapeHtml(data.line1)  : '')
    .replace(/\{\{line2\}\}/g,       (data && data.line2)  ? escapeHtml(data.line2)  : '')
    .replace(/\{\{accentColor\}\}/g, s.accentColor  || '#C8A951')
    .replace(/\{\{font\}\}/g,        line1Font)
    .replace(/\{\{line1Font\}\}/g,   line1Font)
    .replace(/\{\{line2Font\}\}/g,   line2Font)
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
let wsRetryDelay = 5000;   // starts at 5 s; doubles on each failure, caps at 60 s

function initWebSocket() {
  if (location.protocol === 'file:') return;
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = new URL(`${wsProto}//${location.host}`);
  wsUrl.searchParams.set('session', SESSION_ID);
  wsUrl.searchParams.set('role', 'output');
  const url = wsUrl.toString();
  try {
    ws = new WebSocket(url);
    ws.onopen    = () => { wsConnected = true; wsRetryDelay = 5000; };
    ws.onmessage = e => { try { handleMessage(JSON.parse(e.data)); } catch (_) {} };
    ws.onclose   = () => {
      wsConnected = false;
      ws = null;
      setTimeout(initWebSocket, wsRetryDelay);
      wsRetryDelay = Math.min(wsRetryDelay * 2, 60000);
    };
    ws.onerror   = () => { wsConnected = false; };
  } catch (_) {}
}


async function pollStateSnapshot() {
  if (location.protocol === 'file:') return;

  try {
    const response = await fetch('/api/state?session=' + encodeURIComponent(SESSION_ID) + '&_ts=' + Date.now(), {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) return;
    const state = await response.json();
    const updatedAt = Number(state.updatedAt || 0);
    if (!Number.isFinite(updatedAt) || updatedAt <= lastStateUpdatedAt) return;

    if (state.settings) {
      handleMessage({ action: 'settings', settings: state.settings });
    }
    if (state.overlayVisible && state.show) {
      handleMessage({ action: 'show', data: state.show, settings: state.settings || currentSettings || {} });
    } else {
      handleMessage({ action: 'clear' });
    }

    if (state.tickerVisible && state.showTicker) {
      handleMessage({ action: 'show-ticker', data: state.showTicker });
    } else {
      handleMessage({ action: 'clear-ticker' });
    }

    lastStateUpdatedAt = updatedAt;
  } catch (_) {}
}

function startStatePolling() {
  if (statePollTimer) return;
  pollStateSnapshot();
  statePollTimer = setInterval(pollStateSnapshot, 750);
}
