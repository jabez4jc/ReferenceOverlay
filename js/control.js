// ─────────────────────────────────────────────────────────────────────────────
// control.js  —  Operator Control Panel Logic
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Session ID ────────────────────────────────────────────────────────────────
// Each browser tab gets its own session ID so multiple operators can run
// independent control panels with isolated output windows simultaneously.
// The ID is stored in the URL (?session=...) so it survives page reloads.
function getOrCreateSessionId() {
  const params = new URLSearchParams(location.search);
  let id = params.get('session');
  if (!id) {
    // Generate a short random ID and write it into the URL (no page reload)
    id = Math.random().toString(36).slice(2, 9);
    params.set('session', id);
    history.replaceState({}, '', '?' + params.toString());
  }
  return id;
}
const SESSION_ID = getOrCreateSessionId();

// ── State ─────────────────────────────────────────────────────────────────────
let currentMode    = 'bible';  // 'bible' | 'speaker'
let overlayVisible = false;
let outputWindow   = null;

// In-memory image stores (large files may not fit in localStorage)
let ltBgDataUrl   = null;   // lower-third background image
let logoDataUrl   = null;   // logo PNG

// Communication channel (BroadcastChannel primary; localStorage fallback)
// All keys are namespaced with SESSION_ID so multiple users don't collide.
const CHANNEL_NAME = 'reference-overlay-' + SESSION_ID;
const LS_KEY       = 'referenceOverlayState-' + SESSION_ID;
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
  populateFonts();
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
    opt.value        = b.name;
    opt.dataset.abbr = b.abbr;
    opt.textContent  = b.name;
    (b.testament === 'OT' ? otGroup : ntGroup).appendChild(opt);
  });
  // Default to Revelation
  const bookEl = document.getElementById('book');
  bookEl.value = 'Revelation';
  populateChapters('Revelation', 3);
}

function populateChapters(bookName, selectedChapter) {
  const book      = BIBLE_BOOKS.find(b => b.name === bookName);
  const chapterEl = document.getElementById('chapter');
  const prev      = selectedChapter || parseInt(chapterEl.value) || 1;
  chapterEl.innerHTML = '';

  const max = book ? book.maxChapters : 1;
  for (let i = 1; i <= max; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = i;
    chapterEl.appendChild(opt);
  }

  // Restore chapter, clamped to valid range
  chapterEl.value = Math.min(Math.max(prev, 1), max);
}

function populateTranslations() {
  const sel = document.getElementById('translation');
  TRANSLATIONS.forEach(t => {
    const opt = document.createElement('option');
    opt.value       = t.abbr;
    opt.textContent = `${t.abbr} — ${t.name}`;
    sel.appendChild(opt);
  });
  sel.value = 'KJV';  // Default
}

function populateFonts() {
  const sel = document.getElementById('font-select');
  let lastGroup = '';
  FONT_OPTIONS.forEach(f => {
    if (f.group !== lastGroup) {
      const grp = document.createElement('optgroup');
      grp.label = f.group;
      sel.appendChild(grp);
      lastGroup = f.group;
    }
    const opt = document.createElement('option');
    opt.value       = f.value;
    opt.textContent = f.label;
    sel.lastElementChild.appendChild(opt);
  });
  // Default: System UI
  sel.value = 'system-ui';
}

// ── Mode Toggle ───────────────────────────────────────────────────────────────
function setMode(mode) {
  currentMode = mode;

  document.getElementById('tab-bible').classList.toggle('active', mode === 'bible');
  document.getElementById('tab-speaker').classList.toggle('active', mode === 'speaker');
  document.getElementById('panel-bible').classList.toggle('hidden', mode !== 'bible');
  document.getElementById('panel-speaker').classList.toggle('hidden', mode !== 'speaker');

  if (mode === 'bible') {
    document.getElementById('speaker-name').value  = '';
    document.getElementById('speaker-title').value = '';
  }

  updatePreview();
}

// ── Change Handlers ───────────────────────────────────────────────────────────
function onBookChange() {
  const bookName = document.getElementById('book').value;
  populateChapters(bookName, 1);
  // Reset verse ref and validation when book changes
  document.getElementById('verse-ref').value = '';
  document.getElementById('verse-validation').textContent = '';
  document.getElementById('verse-validation').className = 'verse-validation';
  updatePreview();
}

function onBibleChange() {
  validateVerseInput();
  updatePreview();
}
function onSpeakerChange() { updatePreview(); }

// ── Verse Reference Validation ────────────────────────────────────────────────
// Supported formats (verse portion only – no book/chapter):
//   "31"            single verse
//   "31-33"         range
//   "31-33, 46"     range + extra verse(s)
//   "31, 42, 44"    multiple individual verses
//   "31-33, 44-46"  multiple ranges
function parseVerseRef(raw) {
  // Normalise separators: allow dash, en-dash, em-dash for ranges
  const str = raw.trim().replace(/[–—]/g, '-');
  if (!str) return { tokens: [], error: null };

  const segments = str.split(',').map(s => s.trim()).filter(Boolean);
  const tokens   = [];

  for (const seg of segments) {
    if (seg.includes('-')) {
      const parts = seg.split('-').map(s => s.trim());
      if (parts.length !== 2) return { tokens: [], error: `Invalid range: "${seg}"` };
      const a = parseInt(parts[0], 10);
      const b = parseInt(parts[1], 10);
      if (isNaN(a) || isNaN(b)) return { tokens: [], error: `Non-numeric value in "${seg}"` };
      if (a <= 0 || b <= 0)     return { tokens: [], error: `Verse numbers must be ≥ 1` };
      if (a > b)                return { tokens: [], error: `Range start (${a}) must not exceed end (${b})` };
      tokens.push({ type: 'range', from: a, to: b });
    } else {
      const n = parseInt(seg, 10);
      if (isNaN(n)) return { tokens: [], error: `"${seg}" is not a valid verse number` };
      if (n <= 0)   return { tokens: [], error: `Verse numbers must be ≥ 1` };
      tokens.push({ type: 'single', v: n });
    }
  }

  return { tokens, error: null };
}

function validateVerseInput() {
  const validationEl = document.getElementById('verse-validation');
  const raw          = document.getElementById('verse-ref').value.trim();

  if (!raw) {
    validationEl.textContent = '';
    validationEl.className   = 'verse-validation';
    return true;
  }

  const bookName = document.getElementById('book').value;
  const chapIdx  = parseInt(document.getElementById('chapter').value, 10) - 1;
  const book     = BIBLE_BOOKS.find(b => b.name === bookName);
  const maxVerse = book && book.verses ? book.verses[chapIdx] : 999;

  const { tokens, error } = parseVerseRef(raw);

  if (error) {
    validationEl.textContent = '✗ ' + error;
    validationEl.className   = 'verse-validation invalid';
    return false;
  }

  // Check each token against maxVerse
  for (const tok of tokens) {
    if (tok.type === 'single') {
      if (tok.v > maxVerse) {
        validationEl.textContent = `✗ Verse ${tok.v} exceeds chapter max (${maxVerse})`;
        validationEl.className   = 'verse-validation invalid';
        return false;
      }
    } else {
      if (tok.to > maxVerse) {
        validationEl.textContent = `✗ Verse ${tok.to} exceeds chapter max (${maxVerse})`;
        validationEl.className   = 'verse-validation invalid';
        return false;
      }
    }
  }

  validationEl.textContent = `✓ Valid — chapter has ${maxVerse} verses`;
  validationEl.className   = 'verse-validation valid';
  return true;
}

// Format verse reference for display: normalise separators
function formatVerseRef(raw) {
  const { tokens, error } = parseVerseRef(raw);
  if (error || tokens.length === 0) return raw.trim();

  return tokens.map(tok => {
    if (tok.type === 'single') return String(tok.v);
    return `${tok.from}–${tok.to}`;  // en-dash for display
  }).join(', ');
}

// ── Build Overlay Data Object ─────────────────────────────────────────────────
function buildOverlayData() {
  if (currentMode === 'bible') {
    const book       = document.getElementById('book').value;
    const chapter    = document.getElementById('chapter').value || '';
    const verseRaw   = document.getElementById('verse-ref').value.trim();
    const translAbbr = document.getElementById('translation').value;
    const translation = TRANSLATIONS.find(t => t.abbr === translAbbr);

    let ref = book;
    if (chapter) {
      ref += ' ' + chapter;
      if (verseRaw) {
        ref += ':' + formatVerseRef(verseRaw);
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
  const data     = buildOverlayData();
  const settings = getSettings();

  document.getElementById('preview-line1').textContent = data.line1;
  document.getElementById('preview-line2').textContent = data.line2;
  document.getElementById('preview-line2').style.display = data.line2 ? '' : 'none';

  const lt = document.getElementById('preview-lower-third');
  lt.className = 'lower-third';
  lt.classList.add('style-' + settings.style);

  // Background image
  if (settings.ltBgImage) {
    lt.style.backgroundImage    = `url('${settings.ltBgImage}')`;
    lt.style.backgroundSize     = 'cover';
    lt.style.backgroundPosition = 'center';
  } else {
    lt.style.backgroundImage = '';
  }

  // Accent color
  const accent = lt.querySelector('.lt-accent');
  if (accent) accent.style.background = settings.accentColor;

  // Logo
  const logoImg = document.getElementById('preview-logo');
  if (settings.logoDataUrl) {
    logoImg.src = settings.logoDataUrl;
    logoImg.classList.remove('hidden');
    logoImg.classList.toggle('logo-right', settings.logoPosition === 'right');
    logoImg.classList.toggle('logo-left',  settings.logoPosition !== 'right');
    // Position: right-side logos go after lt-text; left-side right after lt-accent
    if (settings.logoPosition === 'right') {
      lt.appendChild(logoImg);
    } else {
      const ltAccent = lt.querySelector('.lt-accent');
      lt.insertBefore(logoImg, ltAccent ? ltAccent.nextSibling : lt.firstChild);
    }
  } else {
    logoImg.classList.add('hidden');
  }

  // Font + alignment
  const ltText = lt.querySelector('.lt-text');
  if (ltText) {
    ltText.style.fontFamily = settings.font;
    ltText.style.textAlign  = settings.textAlign || 'center';
  }
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
  pill.className   = 'status-pill ' + (visible ? 'status-live' : 'status-off');
  pill.textContent = visible ? 'LIVE' : 'OFF AIR';
}

// ── Broadcast ─────────────────────────────────────────────────────────────────
function broadcast(msg) {
  if (outputWindow && !outputWindow.closed) {
    try { outputWindow.postMessage(msg, '*'); } catch (_) {}
  }
  if (channel) {
    try { channel.postMessage(msg); } catch (_) {}
  }
  try {
    // Strip large data URLs from localStorage to avoid quota errors
    const lsMsg = { ...msg };
    if (lsMsg.settings) {
      lsMsg.settings = { ...lsMsg.settings, ltBgImage: null, logoDataUrl: null };
    }
    localStorage.setItem(LS_KEY, JSON.stringify({ ...lsMsg, _ts: Date.now() }));
  } catch (_) {}
}

// ── New Session ────────────────────────────────────────────────────────────────
// Opens a fresh control panel in a new tab with a brand-new session ID.
// Multiple operators can each open their own session and get independent outputs.
function openNewSession() {
  window.open(location.pathname, '_blank');
}

// ── Output Window ──────────────────────────────────────────────────────────────
function openOutputWindow() {
  const settings = getSettings();
  const res      = settings.outputRes.split('x');
  const w        = parseInt(res[0]) || 1920;
  const h        = parseInt(res[1]) || 1080;

  if (outputWindow && !outputWindow.closed) {
    outputWindow.focus();
    return;
  }

  const left = Math.max(0, (screen.width  - w) / 2);
  const top  = Math.max(0, (screen.height - h) / 2);

  outputWindow = window.open(
    'output.html?session=' + SESSION_ID,
    'ReferenceOverlayOutput-' + SESSION_ID,
    `width=${w},height=${h},left=${left},top=${top},` +
    `resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,status=no`
  );

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

  const alignRadio = document.querySelector('input[name="textAlign"]:checked');

  return {
    chroma:        chromaValue,
    animation:     document.getElementById('anim-select')?.value      || 'fade',
    style:         document.getElementById('style-select')?.value     || 'classic',
    accentColor:   document.getElementById('accent-color')?.value     || '#C8A951',
    position:      document.getElementById('position-select')?.value  || 'lower',
    font:          document.getElementById('font-select')?.value      || 'system-ui',
    outputRes:     document.getElementById('output-res')?.value       || '1920x1080',
    textAlign:     alignRadio ? alignRadio.value                      : 'center',
    ltBgImage:     ltBgDataUrl,
    logoDataUrl:   logoDataUrl,
    logoPosition:  document.getElementById('logo-position')?.value    || 'left',
  };
}

function onSettingsChange() {
  updatePreview();
  const settings = getSettings();
  broadcast({ action: 'settings', settings });
  persistSettings(settings);
}

function onCustomChromaChange() {
  const customRadio = document.querySelector('input[name="chroma"][value="custom"]');
  if (customRadio) customRadio.checked = true;
  onSettingsChange();
}

function persistSettings(settings) {
  try {
    // Don't store large data URLs in localStorage main settings — use separate keys
    const small = { ...settings, ltBgImage: null, logoDataUrl: null };
    localStorage.setItem('overlaySettings-' + SESSION_ID, JSON.stringify(small));
    // Store images separately (may throw if too large — handled gracefully)
    if (settings.ltBgImage)   localStorage.setItem('overlayLtBg-' + SESSION_ID,  settings.ltBgImage);
    if (settings.logoDataUrl) localStorage.setItem('overlayLogo-' + SESSION_ID,  settings.logoDataUrl);
  } catch (_) {}
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('overlaySettings-' + SESSION_ID) || '{}');

    if (saved.chroma) {
      const standardRadio = document.querySelector(`input[name="chroma"][value="${saved.chroma}"]`);
      if (standardRadio) {
        standardRadio.checked = true;
      } else {
        document.querySelector('input[name="chroma"][value="custom"]').checked = true;
        document.getElementById('custom-chroma-color').value = saved.chroma;
      }
    }

    if (saved.animation)    document.getElementById('anim-select').value     = saved.animation;
    if (saved.style)        document.getElementById('style-select').value    = saved.style;
    if (saved.accentColor)  document.getElementById('accent-color').value    = saved.accentColor;
    if (saved.position)     document.getElementById('position-select').value = saved.position;
    if (saved.font)         document.getElementById('font-select').value     = saved.font;
    if (saved.outputRes)    document.getElementById('output-res').value      = saved.outputRes;
    if (saved.logoPosition) document.getElementById('logo-position').value   = saved.logoPosition;

    if (saved.textAlign) {
      const r = document.querySelector(`input[name="textAlign"][value="${saved.textAlign}"]`);
      if (r) r.checked = true;
    }

    // Restore images
    const savedLtBg = localStorage.getItem('overlayLtBg-' + SESSION_ID);
    if (savedLtBg) { ltBgDataUrl = savedLtBg; restoreLtBgUI(savedLtBg); }

    const savedLogo = localStorage.getItem('overlayLogo-' + SESSION_ID);
    if (savedLogo) { logoDataUrl = savedLogo; restoreLogoUI(savedLogo); }
  } catch (_) {}
}

// ── Lower Third Background Image ──────────────────────────────────────────────
function onLtBgChange() {
  const file = document.getElementById('lt-bg-file').files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    ltBgDataUrl = e.target.result;
    restoreLtBgUI(ltBgDataUrl, file.name);
    onSettingsChange();
  };
  reader.readAsDataURL(file);
}

function restoreLtBgUI(dataUrl, fileName) {
  const nameEl    = document.getElementById('lt-bg-name');
  const clearBtn  = document.getElementById('lt-bg-clear');
  const prevWrap  = document.getElementById('lt-bg-preview-wrap');
  const prevImg   = document.getElementById('lt-bg-preview');

  nameEl.textContent  = fileName || 'Custom background loaded';
  clearBtn.style.display  = '';
  prevWrap.style.display  = '';
  prevImg.src             = dataUrl;
}

function clearLtBg() {
  ltBgDataUrl = null;
  document.getElementById('lt-bg-file').value         = '';
  document.getElementById('lt-bg-name').textContent   = 'No image selected';
  document.getElementById('lt-bg-clear').style.display = 'none';
  document.getElementById('lt-bg-preview-wrap').style.display = 'none';
  document.getElementById('lt-bg-preview').src = '';
  try { localStorage.removeItem('overlayLtBg-' + SESSION_ID); } catch (_) {}
  onSettingsChange();
}

// ── Logo ─────────────────────────────────────────────────────────────────────
function onLogoChange() {
  const file = document.getElementById('logo-file').files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    logoDataUrl = e.target.result;
    restoreLogoUI(logoDataUrl, file.name);
    onSettingsChange();
  };
  reader.readAsDataURL(file);
}

function restoreLogoUI(dataUrl, fileName) {
  const nameEl      = document.getElementById('logo-name');
  const clearBtn    = document.getElementById('logo-clear');
  const controls    = document.getElementById('logo-controls');
  const prevImg     = document.getElementById('logo-preview');

  nameEl.textContent      = fileName || 'Custom logo loaded';
  clearBtn.style.display  = '';
  controls.style.display  = '';
  prevImg.src             = dataUrl;
}

function clearLogo() {
  logoDataUrl = null;
  document.getElementById('logo-file').value         = '';
  document.getElementById('logo-name').textContent   = 'No logo selected';
  document.getElementById('logo-clear').style.display = 'none';
  document.getElementById('logo-controls').style.display = 'none';
  document.getElementById('logo-preview').src = '';
  try { localStorage.removeItem('overlayLogo-' + SESSION_ID); } catch (_) {}
  onSettingsChange();
}

// ── Keyboard Shortcuts ────────────────────────────────────────────────────────
function bindKeyboard() {
  document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (e.key === 'Enter' && document.activeElement.type === 'text') {
        // Allow Enter on text inputs to trigger Show
        if (document.activeElement.id !== 'verse-ref' &&
            document.activeElement.id !== 'speaker-name' &&
            document.activeElement.id !== 'speaker-title') return;
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
