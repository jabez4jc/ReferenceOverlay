// ─────────────────────────────────────────────────────────────────────────────
// output.js  —  Chroma Key Overlay Output Window Logic
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// Read the session ID from the URL (?session=...) so this output window
// only communicates with its paired control panel, not with other sessions.
const SESSION_ID   = new URLSearchParams(location.search).get('session') || 'default';
const CHANNEL_NAME = 'reference-overlay-' + SESSION_ID;
const LS_KEY       = 'referenceOverlayState-' + SESSION_ID;

// DOM refs
const body    = document.getElementById('output-body');
const ltWrap  = document.getElementById('lt-wrap');
const ltRoot  = document.getElementById('lt-root');
const ltAccent = document.getElementById('lt-accent');
const ltLogo  = document.getElementById('lt-logo');
const ltText  = document.getElementById('lt-text');
const ltLine1 = document.getElementById('lt-line1');
const ltLine2 = document.getElementById('lt-line2');

// ── window.postMessage listener (primary — works on file:// and http://) ───────
window.addEventListener('message', e => {
  if (e.data && typeof e.data === 'object' && e.data.action) {
    handleMessage(e.data);
  }
});

// ── BroadcastChannel listener (hosted / same-origin tab scenario) ─────────────
let channel = null;
try {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = e => handleMessage(e.data);
} catch (_) {
  // Fall through to localStorage polling
}

// ── LocalStorage fallback listener ────────────────────────────────────────────
let lastTs = 0;
window.addEventListener('storage', e => {
  if (e.key === LS_KEY && e.newValue) {
    try {
      const msg = JSON.parse(e.newValue);
      if (msg._ts && msg._ts > lastTs) {
        lastTs = msg._ts;
        handleMessage(msg);
      }
    } catch (_) {}
  }
});

// Also check localStorage on load (handles page-refresh during live show)
window.addEventListener('DOMContentLoaded', () => {
  applyInitialSettings();
  restoreLastState();
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
  }
}

// ── Show / Hide ───────────────────────────────────────────────────────────────
function showOverlay(data) {
  if (!data) return;

  ltLine1.textContent   = data.line1 || '';
  ltLine2.textContent   = data.line2 || '';
  ltLine2.style.display = data.line2 ? '' : 'none';

  // Force reflow so CSS transition fires even on re-show
  ltRoot.classList.remove('visible');
  void ltRoot.offsetWidth;
  ltRoot.classList.add('visible');

  // Persist for page reload
  try {
    sessionStorage.setItem('overlayLive', JSON.stringify({ data, ts: Date.now() }));
  } catch (_) {}
}

function hideOverlay() {
  ltRoot.classList.remove('visible');
  try { sessionStorage.removeItem('overlayLive'); } catch (_) {}
}

// ── Apply Settings ────────────────────────────────────────────────────────────
function applySettings(s) {
  if (!s) return;

  // ── Chroma key background colour ──────────────────────────────────────────
  body.classList.remove('chroma-blue', 'chroma-green', 'chroma-magenta', 'chroma-custom');

  const chromaMap = {
    '#0000ff': 'chroma-blue',
    '#00b140': 'chroma-green',
    '#ff00ff': 'chroma-magenta',
  };

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

  // ── Accent colour ──────────────────────────────────────────────────────────
  if (s.accentColor && ltAccent) {
    ltAccent.style.background = s.accentColor;
    document.documentElement.style.setProperty('--accent-color', s.accentColor);
  }

  // ── Position ──────────────────────────────────────────────────────────────
  ltWrap.classList.remove('pos-lower', 'pos-upper', 'pos-center');
  ltWrap.classList.add('pos-' + (s.position || 'lower'));

  // ── Font ──────────────────────────────────────────────────────────────────
  if (s.font) {
    ltLine1.style.fontFamily = s.font;
    ltLine2.style.fontFamily = s.font;
    if (ltText) ltText.style.fontFamily = s.font;
  }

  // ── Text alignment ────────────────────────────────────────────────────────
  if (ltText) {
    ltText.classList.remove('align-left', 'align-center', 'align-right');
    ltText.classList.add('align-' + (s.textAlign || 'center'));
    ltText.style.textAlign = s.textAlign || 'center';
  }

  // ── Lower third background image ──────────────────────────────────────────
  if (s.ltBgImage) {
    ltRoot.style.backgroundImage    = `url('${s.ltBgImage}')`;
    ltRoot.style.backgroundSize     = 'cover';
    ltRoot.style.backgroundPosition = 'center';
    ltRoot.style.backgroundRepeat   = 'no-repeat';
  } else {
    ltRoot.style.backgroundImage = '';
  }

  // ── Logo ──────────────────────────────────────────────────────────────────
  if (s.logoDataUrl) {
    ltLogo.src         = s.logoDataUrl;
    ltLogo.style.display = '';

    // Apply position class
    ltLogo.classList.remove('logo-left', 'logo-right');
    ltLogo.classList.add(s.logoPosition === 'right' ? 'logo-right' : 'logo-left');

    // Re-order in DOM to match position setting
    if (s.logoPosition === 'right') {
      // Right of text block: move logo to end of ltRoot
      ltRoot.appendChild(ltLogo);
    } else {
      // Left of text block: insert after accent strip
      ltRoot.insertBefore(ltLogo, ltText);
    }
  } else {
    ltLogo.style.display = 'none';
    ltLogo.src           = '';
  }
}

// ── Apply settings from localStorage on load ──────────────────────────────────
function applyInitialSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('overlaySettings-' + SESSION_ID) || '{}');

    // Restore images from their own localStorage keys
    const ltBg = localStorage.getItem('overlayLtBg-' + SESSION_ID);
    if (ltBg) saved.ltBgImage = ltBg;

    const logo = localStorage.getItem('overlayLogo-' + SESSION_ID);
    if (logo) saved.logoDataUrl = logo;

    if (Object.keys(saved).length) applySettings(saved);
  } catch (_) {}
}

// ── Restore live state after a page reload ────────────────────────────────────
function restoreLastState() {
  try {
    const live = JSON.parse(sessionStorage.getItem('overlayLive') || 'null');
    if (live && live.data) {
      setTimeout(() => showOverlay(live.data), 100);
    }
  } catch (_) {}

  // Also check localStorage for the last broadcast
  try {
    const last = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (last && last.action === 'show' && last.data) {
      lastTs = last._ts || 0;
      applySettings(last.settings);
      setTimeout(() => showOverlay(last.data), 150);
    }
  } catch (_) {}
}
