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
    id = Math.random().toString(36).slice(2, 9);
    params.set('session', id);
    history.replaceState({}, '', '?' + params.toString());
  }
  return id;
}
const SESSION_ID = getOrCreateSessionId();

// ── State ─────────────────────────────────────────────────────────────────────
let currentMode    = 'bible';   // 'bible' | 'speaker'
let overlayVisible = false;
let outputWindows  = [];        // ← array for multiple simultaneous targets

// In-memory image stores (large files may not fit in localStorage)
let ltBgDataUrl  = null;
let logoDataUrl  = null;

// Verse text lookup state
let verseTextCurrent = null;    // last successfully fetched verse text
let verseTextCache   = {};      // { "Book Ch:V|trans": "verse text..." }
let lookupTimer      = null;    // debounce handle

// Presets
let presets = [];

// Communication channels (BroadcastChannel primary; localStorage fallback)
// All keys are namespaced with SESSION_ID so multiple users don't collide.
const CHANNEL_NAME = 'reference-overlay-' + SESSION_ID;
const LS_KEY       = 'referenceOverlayState-' + SESSION_ID;
let channel        = null;

try {
  channel = new BroadcastChannel(CHANNEL_NAME);
} catch (_) {}

// WebSocket client — only active when served via http:// (server.js mode)
let ws      = null;
const WS_PORT = parseInt(location.port) || 3333;

// ── Initialise ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  populateBooks();
  populateTranslations();
  populateFonts();
  loadSettings();
  loadPresets();
  updatePreview();
  bindKeyboard();
  initWebSocket();
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
  sel.value = 'KJV';
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
  document.getElementById('verse-ref').value = '';
  document.getElementById('verse-validation').textContent = '';
  document.getElementById('verse-validation').className = 'verse-validation';
  clearVerseText();
  updatePreview();
}

function onBibleChange() {
  validateVerseInput();
  clearVerseText();
  updatePreview();
}
function onSpeakerChange() { updatePreview(); }

// ── Verse Reference Validation ────────────────────────────────────────────────
function parseVerseRef(raw) {
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

function formatVerseRef(raw) {
  const { tokens, error } = parseVerseRef(raw);
  if (error || tokens.length === 0) return raw.trim();
  return tokens.map(tok =>
    tok.type === 'single' ? String(tok.v) : `${tok.from}–${tok.to}`
  ).join(', ');
}

// ── Bible API — Verse Text Lookup ─────────────────────────────────────────────
// Uses the free bible-api.com API (no key required).
// Supported translations: KJV, ASV, WEB, YLT, DARBY, BBE (see data.js).

function lookupVerse() {
  const book       = document.getElementById('book').value;
  const chapter    = document.getElementById('chapter').value;
  const verseRaw   = document.getElementById('verse-ref').value.trim();
  const transAbbr  = document.getElementById('translation').value;

  if (!chapter || !verseRaw) {
    setLookupStatus('Enter a chapter and verse first.', 'error');
    return;
  }

  const { tokens, error } = parseVerseRef(verseRaw);
  if (error || tokens.length === 0) {
    setLookupStatus('Fix verse reference before looking up.', 'error');
    return;
  }

  // Build the API verse string from the first token only (ranges supported)
  const tok = tokens[0];
  const verseParam = tok.type === 'single' ? tok.v : `${tok.from}-${tok.to}`;
  const ref        = `${book} ${chapter}:${verseParam}`;
  const apiTrans   = BIBLE_API_MAP[transAbbr];
  const cacheKey   = ref + '|' + (apiTrans || '');

  if (verseTextCache[cacheKey]) {
    displayVerseText(verseTextCache[cacheKey]);
    return;
  }

  if (!apiTrans) {
    setLookupStatus(
      `${transAbbr} is not available via the free API. Try KJV, ASV, or WEB.`,
      'error'
    );
    return;
  }

  setLookupStatus('Looking up…', 'loading');

  const url = `https://bible-api.com/${encodeURIComponent(ref)}?translation=${apiTrans}`;

  fetch(url)
    .then(r => {
      if (!r.ok) throw new Error(`Server returned ${r.status}`);
      return r.json();
    })
    .then(data => {
      // bible-api.com returns { text } for single verse or { verses:[{text}] } for ranges
      let text = data.text;
      if (!text && Array.isArray(data.verses)) {
        text = data.verses.map(v => v.text.trim()).join(' ');
      }
      if (!text) throw new Error('No text in response');
      const clean = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      verseTextCache[cacheKey] = clean;
      displayVerseText(clean);
      setLookupStatus('', '');
    })
    .catch(err => {
      setLookupStatus(`Lookup failed: ${err.message}`, 'error');
    });
}

function setLookupStatus(msg, type) {
  const el = document.getElementById('lookup-status');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'lookup-status' + (type ? ' lookup-' + type : '');
}

function displayVerseText(text) {
  verseTextCurrent = text;
  const box     = document.getElementById('verse-text-box');
  const content = document.getElementById('verse-text-content');
  if (!box || !content) return;
  box.style.display    = '';
  content.textContent  = text;
  updatePreview();
}

function clearVerseText() {
  verseTextCurrent = null;
  const box = document.getElementById('verse-text-box');
  if (box) box.style.display = 'none';
  const chk = document.getElementById('include-verse-text');
  if (chk) chk.checked = false;
  setLookupStatus('', '');
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
      if (verseRaw) ref += ':' + formatVerseRef(verseRaw);
    }

    const includeText = document.getElementById('include-verse-text')?.checked;
    const line2 = (includeText && verseTextCurrent)
      ? verseTextCurrent
      : (translation ? translation.name : translAbbr);

    return { type: 'bible', line1: ref, line2 };
  } else {
    const name  = document.getElementById('speaker-name').value.trim();
    const title = document.getElementById('speaker-title').value.trim();
    return { type: 'speaker', line1: name || '(Speaker name)', line2: title || '' };
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

  if (settings.ltBgImage) {
    lt.style.backgroundImage    = `url('${settings.ltBgImage}')`;
    lt.style.backgroundSize     = 'cover';
    lt.style.backgroundPosition = 'center';
  } else {
    lt.style.backgroundImage = '';
  }

  const accent = lt.querySelector('.lt-accent');
  if (accent) accent.style.background = settings.accentColor;

  const logoImg = document.getElementById('preview-logo');
  if (settings.logoDataUrl) {
    logoImg.src = settings.logoDataUrl;
    logoImg.classList.remove('hidden');
    logoImg.classList.toggle('logo-right', settings.logoPosition === 'right');
    logoImg.classList.toggle('logo-left',  settings.logoPosition !== 'right');
    if (settings.logoPosition === 'right') {
      lt.appendChild(logoImg);
    } else {
      const ltAccent = lt.querySelector('.lt-accent');
      lt.insertBefore(logoImg, ltAccent ? ltAccent.nextSibling : lt.firstChild);
    }
  } else {
    logoImg.classList.add('hidden');
  }

  const ltText = lt.querySelector('.lt-text');
  if (ltText) {
    ltText.style.fontFamily = settings.font;
    ltText.style.textAlign  = settings.textAlign || 'center';
  }
}

// ── Presets ───────────────────────────────────────────────────────────────────
function loadPresets() {
  try {
    presets = JSON.parse(localStorage.getItem('overlayPresets-' + SESSION_ID) || '[]');
  } catch (_) { presets = []; }
  renderPresets();
}

function saveCurrentPreset() {
  // Generate a default label from current fields
  let defaultLabel = '';
  if (currentMode === 'bible') {
    const book  = document.getElementById('book').value;
    const ch    = document.getElementById('chapter').value;
    const verse = document.getElementById('verse-ref').value.trim();
    const trans = document.getElementById('translation').value;
    defaultLabel = verse ? `${book} ${ch}:${verse} (${trans})` : `${book} ${ch}`;
  } else {
    const name  = document.getElementById('speaker-name').value.trim();
    const title = document.getElementById('speaker-title').value.trim();
    defaultLabel = title ? `${name} — ${title}` : name;
  }

  const label = prompt('Preset name:', defaultLabel);
  if (label === null) return;             // cancelled
  if (!label.trim()) return;             // empty

  const preset = {
    id:    Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    label: label.trim(),
    mode:  currentMode,
    data:  currentMode === 'bible' ? {
      book:        document.getElementById('book').value,
      chapter:     document.getElementById('chapter').value,
      verse:       document.getElementById('verse-ref').value,
      translation: document.getElementById('translation').value,
    } : {
      name:  document.getElementById('speaker-name').value,
      title: document.getElementById('speaker-title').value,
    },
  };

  presets.push(preset);
  savePresetsToStorage();
  renderPresets();
}

function loadPreset(id) {
  const p = presets.find(x => x.id === id);
  if (!p) return;

  setMode(p.mode);
  clearVerseText();

  if (p.mode === 'bible') {
    document.getElementById('book').value = p.data.book;
    populateChapters(p.data.book, parseInt(p.data.chapter));
    document.getElementById('chapter').value     = p.data.chapter;
    document.getElementById('verse-ref').value   = p.data.verse;
    document.getElementById('translation').value = p.data.translation;
    validateVerseInput();
  } else {
    document.getElementById('speaker-name').value  = p.data.name;
    document.getElementById('speaker-title').value = p.data.title;
  }
  updatePreview();
}

function deletePreset(id) {
  presets = presets.filter(p => p.id !== id);
  savePresetsToStorage();
  renderPresets();
}

function savePresetsToStorage() {
  try {
    localStorage.setItem('overlayPresets-' + SESSION_ID, JSON.stringify(presets));
  } catch (_) {}
}

function renderPresets() {
  const list  = document.getElementById('presets-list');
  const empty = document.getElementById('presets-empty');
  if (!list) return;

  list.querySelectorAll('.preset-chip').forEach(el => el.remove());

  if (presets.length === 0) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  presets.forEach(p => {
    const chip = document.createElement('div');
    chip.className  = 'preset-chip';
    chip.dataset.id = p.id;

    const loadBtn = document.createElement('button');
    loadBtn.className   = 'preset-load';
    loadBtn.textContent = p.label;
    if (p.mode === 'bible') {
      loadBtn.title = `${p.data.book} ${p.data.chapter}:${p.data.verse} (${p.data.translation})`;
    } else {
      loadBtn.title = `${p.data.name}${p.data.title ? ' — ' + p.data.title : ''}`;
    }
    loadBtn.addEventListener('click', () => loadPreset(p.id));

    const delBtn = document.createElement('button');
    delBtn.className   = 'preset-delete';
    delBtn.textContent = '×';
    delBtn.title       = 'Remove preset';
    delBtn.addEventListener('click', e => { e.stopPropagation(); deletePreset(p.id); });

    chip.append(loadBtn, delBtn);
    list.appendChild(chip);
  });
}

// ── Send to Output ────────────────────────────────────────────────────────────
function sendShow() {
  const data     = buildOverlayData();
  const settings = getSettings();
  broadcast({ action: 'show', data, settings });
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
  // 1. All open output windows via postMessage
  outputWindows = outputWindows.filter(w => !w.closed);
  outputWindows.forEach(w => {
    try { w.postMessage(msg, '*'); } catch (_) {}
  });

  // 2. BroadcastChannel (same-origin tabs)
  if (channel) {
    try { channel.postMessage(msg); } catch (_) {}
  }

  // 3. localStorage fallback
  try {
    const lsMsg = { ...msg };
    if (lsMsg.settings) lsMsg.settings = { ...lsMsg.settings, ltBgImage: null, logoDataUrl: null };
    localStorage.setItem(LS_KEY, JSON.stringify({ ...lsMsg, _ts: Date.now() }));
  } catch (_) {}

  // 4. WebSocket (server mode)
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      const wsMsg = { ...msg };
      if (wsMsg.settings) wsMsg.settings = { ...wsMsg.settings, ltBgImage: null, logoDataUrl: null };
      ws.send(JSON.stringify(wsMsg));
    } catch (_) {}
  }
}

// ── New Session ───────────────────────────────────────────────────────────────
function openNewSession() {
  window.open(location.pathname, '_blank');
}

// ── Multiple Output Targets ───────────────────────────────────────────────────
function openOutputWindow() {
  const settings = getSettings();
  const res = settings.outputRes.split('x');
  const w   = parseInt(res[0]) || 1920;
  const h   = parseInt(res[1]) || 1080;

  // Stagger each new window 30px down-right so they don't stack exactly
  outputWindows = outputWindows.filter(win => !win.closed);
  const idx  = outputWindows.length;
  const left = Math.max(0, Math.round((screen.width  - w) / 2) + idx * 30);
  const top  = Math.max(0, Math.round((screen.height - h) / 2) + idx * 30);

  const win = window.open(
    'output.html?session=' + SESSION_ID,
    'OverlayOutput-' + SESSION_ID + '-' + idx,
    `width=${w},height=${h},left=${left},top=${top},` +
    `resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,status=no`
  );

  if (win) {
    outputWindows.push(win);
    updateOutputCount();
    win.addEventListener('load', () => {
      const s = getSettings();
      broadcast({ action: 'settings', settings: s });
      if (overlayVisible) {
        setTimeout(() => broadcast({ action: 'show', data: buildOverlayData(), settings: s }), 200);
      }
    });
  }
}

function updateOutputCount() {
  outputWindows = outputWindows.filter(w => !w.closed);
  const btn = document.getElementById('btn-open-output');
  if (!btn) return;
  const count = outputWindows.length;
  btn.dataset.count = count > 0 ? count : '';
}

// ── WebSocket Client (server.js mode) ─────────────────────────────────────────
// Automatically connects when the app is served via http:// rather than file://.
// Lets tablets/phones on the same network control this session as a remote.
function initWebSocket() {
  if (location.protocol === 'file:') return;   // WS only available on http://

  const url = `ws://${location.hostname}:${WS_PORT}?session=${SESSION_ID}&role=control`;
  try {
    ws = new WebSocket(url);
    ws.onopen    = () => setWsIndicator('online');
    ws.onclose   = () => {
      ws = null;
      setWsIndicator('offline');
      setTimeout(initWebSocket, 5000);   // auto-reconnect
    };
    ws.onerror   = () => setWsIndicator('error');
    ws.onmessage = e => {
      // Receive remote show/clear commands from tablet/phone
      try { handleRemoteCommand(JSON.parse(e.data)); } catch (_) {}
    };
  } catch (_) {}
}

function setWsIndicator(state) {
  const el = document.getElementById('ws-indicator');
  if (!el) return;
  el.dataset.state = state;
  const labels = {
    online:  'WebSocket connected — remote control active',
    offline: 'WebSocket server not running',
    error:   'WebSocket error',
  };
  el.title = labels[state] || '';
}

function handleRemoteCommand(msg) {
  if (!msg || !msg.action) return;
  if (msg.action === 'show')  sendShow();
  if (msg.action === 'clear') sendClear();
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
    customTemplate: {
      enabled: document.getElementById('use-custom-template')?.checked || false,
      html:    document.getElementById('template-html')?.value         || '',
      css:     document.getElementById('template-css')?.value          || '',
    },
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
    const small = { ...settings, ltBgImage: null, logoDataUrl: null };
    localStorage.setItem('overlaySettings-' + SESSION_ID, JSON.stringify(small));
    if (settings.ltBgImage)   localStorage.setItem('overlayLtBg-'  + SESSION_ID, settings.ltBgImage);
    if (settings.logoDataUrl) localStorage.setItem('overlayLogo-'  + SESSION_ID, settings.logoDataUrl);
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

    // Restore custom template
    if (saved.customTemplate) {
      const enableEl = document.getElementById('use-custom-template');
      const htmlEl   = document.getElementById('template-html');
      const cssEl    = document.getElementById('template-css');
      if (enableEl && saved.customTemplate.enabled !== undefined) enableEl.checked = saved.customTemplate.enabled;
      if (htmlEl   && saved.customTemplate.html    !== undefined) htmlEl.value    = saved.customTemplate.html;
      if (cssEl    && saved.customTemplate.css     !== undefined) cssEl.value     = saved.customTemplate.css;
    }

    // Restore images
    const savedLtBg = localStorage.getItem('overlayLtBg-' + SESSION_ID);
    if (savedLtBg) { ltBgDataUrl = savedLtBg; restoreLtBgUI(savedLtBg); }

    const savedLogo = localStorage.getItem('overlayLogo-' + SESSION_ID);
    if (savedLogo) { logoDataUrl = savedLogo; restoreLogoUI(savedLogo); }

  } catch (_) {}
}

// ── Custom Template ───────────────────────────────────────────────────────────
const DEFAULT_TEMPLATE_HTML = `<div class="custom-lt">
  <div class="custom-lt-line1">{{line1}}</div>
  <div class="custom-lt-line2">{{line2}}</div>
</div>`;

const DEFAULT_TEMPLATE_CSS = `.custom-lt {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 18px 28px;
  background: rgba(0,0,0,.82);
  border-left: 8px solid {{accentColor}};
  font-family: {{font}};
  min-width: 400px;
}
.custom-lt-line1 {
  font-size: 52px;
  font-weight: 700;
  color: #fff;
  line-height: 1.15;
}
.custom-lt-line2 {
  font-size: 34px;
  font-weight: 400;
  color: rgba(255,255,255,.75);
}`;

function resetTemplate() {
  const htmlEl = document.getElementById('template-html');
  const cssEl  = document.getElementById('template-css');
  if (htmlEl) htmlEl.value = DEFAULT_TEMPLATE_HTML;
  if (cssEl)  cssEl.value  = DEFAULT_TEMPLATE_CSS;
  onSettingsChange();
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
  document.getElementById('lt-bg-name').textContent        = fileName || 'Custom background loaded';
  document.getElementById('lt-bg-clear').style.display     = '';
  document.getElementById('lt-bg-preview-wrap').style.display = '';
  document.getElementById('lt-bg-preview').src             = dataUrl;
}

function clearLtBg() {
  ltBgDataUrl = null;
  document.getElementById('lt-bg-file').value              = '';
  document.getElementById('lt-bg-name').textContent        = 'No image selected';
  document.getElementById('lt-bg-clear').style.display     = 'none';
  document.getElementById('lt-bg-preview-wrap').style.display = 'none';
  document.getElementById('lt-bg-preview').src             = '';
  try { localStorage.removeItem('overlayLtBg-' + SESSION_ID); } catch (_) {}
  onSettingsChange();
}

// ── Logo ──────────────────────────────────────────────────────────────────────
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
  document.getElementById('logo-name').textContent     = fileName || 'Custom logo loaded';
  document.getElementById('logo-clear').style.display  = '';
  document.getElementById('logo-controls').style.display = '';
  document.getElementById('logo-preview').src          = dataUrl;
}

function clearLogo() {
  logoDataUrl = null;
  document.getElementById('logo-file').value           = '';
  document.getElementById('logo-name').textContent     = 'No logo selected';
  document.getElementById('logo-clear').style.display  = 'none';
  document.getElementById('logo-controls').style.display = 'none';
  document.getElementById('logo-preview').src          = '';
  try { localStorage.removeItem('overlayLogo-' + SESSION_ID); } catch (_) {}
  onSettingsChange();
}

// ── Keyboard Shortcuts ────────────────────────────────────────────────────────
function bindKeyboard() {
  document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (e.key === 'Enter' && document.activeElement.type === 'text') {
        const id = document.activeElement.id;
        if (id === 'verse-ref' || id === 'speaker-name' || id === 'speaker-title') {
          e.preventDefault();
          sendShow();
        }
      }
      return;
    }

    switch (e.key) {
      case 'Enter':   e.preventDefault(); sendShow();                break;
      case 'Escape':  e.preventDefault(); sendClear();               break;
      case 'b': case 'B': setMode('bible');                          break;
      case 's': case 'S': setMode('speaker');                        break;
      case 'o': case 'O': openOutputWindow();                        break;
    }
  });
}
