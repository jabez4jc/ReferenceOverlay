// ─────────────────────────────────────────────────────────────────────────────
// control.js  —  Operator Control Panel Logic
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentMode    = 'bible';  // 'bible' | 'speaker'
let overlayVisible = false;
let outputWindow   = null;

// Communication channel (BroadcastChannel primary; localStorage fallback)
const CHANNEL_NAME = 'reference-overlay';
const LS_KEY       = 'referenceOverlayState';
let channel        = null;

try {
  channel = new BroadcastChannel(CHANNEL_NAME);
} catch (_) {
  // BroadcastChannel not supported — localStorage fallback only
}

// ── Initialise ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  populateBooks();
  populateTranslations();
  loadSettings();
  updatePreview();
  bindKeyboard();
});

// ── Populate Dropdowns ────────────────────────────────────────────────────────
function populateBooks() {
  const otGroup = document.getElementById('optgroup-ot');
  const ntGroup = document.getElementById('optgroup-nt');
  BIBLE_BOOKS.forEach(b => {
    const opt = document.createElement('option');
    opt.value   = b.name;
    opt.dataset.abbr = b.abbr;
    opt.textContent  = b.name;
    (b.testament === 'OT' ? otGroup : ntGroup).appendChild(opt);
  });
  // Default to Revelation (matches sheet sample)
  const bookEl = document.getElementById('book');
  bookEl.value = 'Revelation';
}

function populateTranslations() {
  const sel = document.getElementById('translation');
  TRANSLATIONS.forEach(t => {
    const opt = document.createElement('option');
    opt.value       = t.abbr;
    opt.textContent = `${t.abbr} — ${t.name}`;
    sel.appendChild(opt);
  });
  sel.value = 'KJV';  // Default to match sheet sample
}

// ── Mode Toggle ───────────────────────────────────────────────────────────────
function setMode(mode) {
  currentMode = mode;

  document.getElementById('tab-bible').classList.toggle('active', mode === 'bible');
  document.getElementById('tab-speaker').classList.toggle('active', mode === 'speaker');
  document.getElementById('panel-bible').classList.toggle('hidden', mode !== 'bible');
  document.getElementById('panel-speaker').classList.toggle('hidden', mode !== 'speaker');

  // Clear speaker inputs when switching away
  if (mode === 'bible') {
    document.getElementById('speaker-name').value  = '';
    document.getElementById('speaker-title').value = '';
  }

  updatePreview();
}

// ── Change Handlers ───────────────────────────────────────────────────────────
function onBibleChange() { updatePreview(); }
function onSpeakerChange() { updatePreview(); }

// ── Build Overlay Data Object ─────────────────────────────────────────────────
function buildOverlayData() {
  if (currentMode === 'bible') {
    const bookEl       = document.getElementById('book');
    const book         = bookEl.value;
    const chapter      = document.getElementById('chapter').value || '';
    const verseStart   = document.getElementById('verse-start').value || '';
    const verseEnd     = document.getElementById('verse-end').value   || '';
    const translAbbr   = document.getElementById('translation').value;
    const translation  = TRANSLATIONS.find(t => t.abbr === translAbbr);

    // Build line 1:  Book Chapter:Verse  or  Book Chapter:Verse-EndVerse
    let ref = book;
    if (chapter) {
      ref += ' ' + chapter;
      if (verseStart) {
        ref += ':' + verseStart;
        if (verseEnd) ref += '–' + verseEnd;
      }
    }

    return {
      type:  'bible',
      line1: ref,
      line2: translation ? translation.name : translAbbr,
    };
  } else {
    const name  = document.getElementById('speaker-name').value.trim();
    const title = document.getElementById('speaker-title').value.trim();
    return {
      type:  'speaker',
      line1: name  || '(Speaker name)',
      line2: title || '',
    };
  }
}

// ── Preview ───────────────────────────────────────────────────────────────────
function updatePreview() {
  const data = buildOverlayData();
  document.getElementById('preview-line1').textContent = data.line1;
  document.getElementById('preview-line2').textContent = data.line2;
  document.getElementById('preview-line2').style.display = data.line2 ? '' : 'none';

  // Apply style to preview lower third
  const lt = document.getElementById('preview-lower-third');
  const settings = getSettings();
  lt.className = 'lower-third';  // reset
  lt.classList.add('style-' + settings.style);

  const accent = lt.querySelector('.lt-accent');
  if (accent) accent.style.background = settings.accentColor;

  const ltText = lt.querySelector('.lt-text');
  if (ltText) ltText.style.fontFamily = settings.font;
}

// ── Send to Output Window ──────────────────────────────────────────────────────
function sendShow() {
  const data     = buildOverlayData();
  const settings = getSettings();
  const msg      = { action: 'show', data, settings };

  broadcast(msg);
  setOverlayStatus(true);
  updatePreview();
}

function sendClear() {
  broadcast({ action: 'clear' });
  setOverlayStatus(false);
}

function setOverlayStatus(visible) {
  overlayVisible = visible;
  const pill = document.getElementById('status-pill');
  pill.className = 'status-pill ' + (visible ? 'status-live' : 'status-off');
  pill.textContent = visible ? 'LIVE' : 'OFF AIR';
}

// ── Broadcast ─────────────────────────────────────────────────────────────────
// Priority order:
//   1. window.postMessage  — works on file:// AND http://, most reliable
//   2. BroadcastChannel   — works on http:// between same-origin tabs
//   3. localStorage       — fallback; storage event fires in other windows
function broadcast(msg) {
  // 1. Direct postMessage to output window (bypasses all origin restrictions)
  if (outputWindow && !outputWindow.closed) {
    try { outputWindow.postMessage(msg, '*'); } catch (_) {}
  }
  // 2. BroadcastChannel (for hosted scenarios where output.html is a separate tab)
  if (channel) {
    try { channel.postMessage(msg); } catch (_) {}
  }
  // 3. localStorage (storage event fires in other same-origin windows)
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...msg, _ts: Date.now() }));
  } catch (_) {}
}

// ── Output Window ──────────────────────────────────────────────────────────────
function openOutputWindow() {
  const settings = getSettings();
  const res      = settings.outputRes.split('x');
  const w        = parseInt(res[0]) || 1920;
  const h        = parseInt(res[1]) || 1080;

  // Open (or re-focus) the output window
  if (outputWindow && !outputWindow.closed) {
    outputWindow.focus();
    return;
  }

  // Compute a screen position (centred on current screen)
  const left = Math.max(0, (screen.width  - w) / 2);
  const top  = Math.max(0, (screen.height - h) / 2);

  outputWindow = window.open(
    'output.html',
    'ReferenceOverlayOutput',
    `width=${w},height=${h},left=${left},top=${top},` +
    `resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,status=no`
  );

  // Re-send current settings once the output window loads
  if (outputWindow) {
    outputWindow.addEventListener('load', () => {
      const settings = getSettings();
      broadcast({ action: 'settings', settings });
      if (overlayVisible) {
        setTimeout(() => broadcast({ action: 'show', data: buildOverlayData(), settings }), 200);
      }
    });
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
function getSettings() {
  const chromaRadio = document.querySelector('input[name="chroma"]:checked');
  let chromaValue   = chromaRadio ? chromaRadio.value : '#0000FF';
  if (chromaValue === 'custom') {
    chromaValue = document.getElementById('custom-chroma-color').value;
  }

  return {
    chroma:      chromaValue,
    animation:   document.getElementById('anim-select')?.value    || 'fade',
    style:       document.getElementById('style-select')?.value   || 'classic',
    accentColor: document.getElementById('accent-color')?.value   || '#C8A951',
    position:    document.getElementById('position-select')?.value || 'lower',
    font:        document.getElementById('font-select')?.value    || 'system-ui',
    outputRes:   document.getElementById('output-res')?.value     || '1920x1080',
  };
}

function onSettingsChange() {
  updatePreview();
  const settings = getSettings();
  broadcast({ action: 'settings', settings });
  persistSettings(settings);
}

function onCustomChromaChange() {
  // Select the "custom" radio automatically
  const customRadio = document.querySelector('input[name="chroma"][value="custom"]');
  if (customRadio) customRadio.checked = true;
  onSettingsChange();
}

function persistSettings(settings) {
  try { localStorage.setItem('overlaySettings', JSON.stringify(settings)); } catch (_) {}
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('overlaySettings') || '{}');

    if (saved.chroma) {
      const standardRadio = document.querySelector(`input[name="chroma"][value="${saved.chroma}"]`);
      if (standardRadio) {
        standardRadio.checked = true;
      } else {
        document.querySelector('input[name="chroma"][value="custom"]').checked = true;
        document.getElementById('custom-chroma-color').value = saved.chroma;
      }
    }

    if (saved.animation)   document.getElementById('anim-select').value      = saved.animation;
    if (saved.style)       document.getElementById('style-select').value      = saved.style;
    if (saved.accentColor) document.getElementById('accent-color').value      = saved.accentColor;
    if (saved.position)    document.getElementById('position-select').value   = saved.position;
    if (saved.font)        document.getElementById('font-select').value       = saved.font;
    if (saved.outputRes)   document.getElementById('output-res').value        = saved.outputRes;
  } catch (_) {}
}

// ── Keyboard Shortcuts ────────────────────────────────────────────────────────
function bindKeyboard() {
  document.addEventListener('keydown', e => {
    // Ignore shortcuts when typing in an input/select
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      // Allow Enter to trigger Show when focus is on a non-text numeric input
      if (e.key === 'Enter' && document.activeElement.type === 'number') {
        e.preventDefault();
        sendShow();
      }
      return;
    }

    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        sendShow();
        break;
      case 'Escape':
        e.preventDefault();
        sendClear();
        break;
      case 'b': case 'B':
        setMode('bible');
        break;
      case 's': case 'S':
        setMode('speaker');
        break;
      case 'o': case 'O':
        openOutputWindow();
        break;
    }
  });
}
