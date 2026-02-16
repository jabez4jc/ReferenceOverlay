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
let currentMode    = 'bible';   // 'bible' | 'speaker' | 'ticker'
let overlayVisible = false;
let tickerActive   = false;
let outputWindows  = [];        // ← array for multiple simultaneous targets

// Program state — frozen snapshot of what is currently live on output
let programOverlayData     = null;
let programOverlaySettings = null;
let programOverlayLive     = false;
let programTickerData      = null;
let programTickerLive      = false;

// In-memory image stores (large files may not fit in localStorage)
let ltBgDataUrl  = null;
let logoDataUrl  = null;

// Verse text lookup state
let verseTextCurrent    = null;   // last successfully fetched verse text
let verseTextCache      = {};     // { cacheKey: { text, refOnly } }
let referenceOnlyLookup = false;  // true when text is ASV reference, not for output

// Presets — separate stores for overlay (bible/speaker) vs ticker
let overlayPresets = [];
let tickerPresets  = [];

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

  // Display short session ID in the header badge
  const sessionBadge = document.getElementById('session-id-text');
  if (sessionBadge) sessionBadge.textContent = '#' + SESSION_ID;

  // Populate the Browser Source URL in the settings panel
  const bsiUrl = document.getElementById('bsi-url');
  if (bsiUrl) {
    const outputUrl = location.origin
      + location.pathname.replace(/[^/]*$/, '')
      + 'output.html?session=' + SESSION_ID;
    bsiUrl.textContent = outputUrl;
  }

  // Restore transparent note visibility
  const savedChroma = document.querySelector('input[name="chroma"]:checked')?.value;
  const note = document.getElementById('chroma-transparent-note');
  if (note) note.style.display = (savedChroma === 'transparent') ? '' : 'none';
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

  // "None" — hides the translation name from output (line2 will be empty)
  const noneOpt = document.createElement('option');
  noneOpt.value       = 'NONE';
  noneOpt.textContent = '— None (hide translation) —';
  sel.appendChild(noneOpt);

  // Three optgroups based on lookup availability
  const grpFree    = document.createElement('optgroup');
  grpFree.label    = 'Lookup Available — Free';
  const grpPremium = document.createElement('optgroup');
  grpPremium.label = 'Lookup Available — Premium';
  const grpRef     = document.createElement('optgroup');
  grpRef.label     = 'Reference Only';

  TRANSLATIONS.forEach(t => {
    const opt = document.createElement('option');
    opt.value       = t.abbr;
    opt.textContent = `${t.abbr} — ${t.name}`;
    if (BIBLE_API_MAP[t.abbr] || HELLOAO_MAP[t.abbr]) {
      grpFree.appendChild(opt);
    } else if (APIBIBLE_IDS[t.abbr]) {
      grpPremium.appendChild(opt);
    } else {
      grpRef.appendChild(opt);
    }
  });

  sel.appendChild(grpFree);
  sel.appendChild(grpPremium);
  sel.appendChild(grpRef);
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
  document.getElementById('tab-ticker').classList.toggle('active', mode === 'ticker');
  document.getElementById('panel-bible').classList.toggle('hidden', mode !== 'bible');
  document.getElementById('panel-speaker').classList.toggle('hidden', mode !== 'speaker');
  document.getElementById('panel-ticker').classList.toggle('hidden', mode !== 'ticker');

  if (mode === 'bible') {
    document.getElementById('speaker-name').value  = '';
    document.getElementById('speaker-title').value = '';
  }

  renderPresets();
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

function onTickerChange() { updatePreview(); }

function onTickerStyleChange() {
  const style  = document.getElementById('ticker-style')?.value;
  const custom = document.getElementById('ticker-custom-colors');
  if (custom) custom.classList.toggle('visible', style === 'custom');
  updatePreview();
}

// ── Verse Reference Validation ────────────────────────────────────────────────
function parseVerseRef(raw) {
  // Strip trailing separator characters before parsing
  const str = raw.trim().replace(/[–—]/g, '-').replace(/[-,.\s]+$/, '');
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

// Walk tokens in order; stop (and clamp ranges) at the first value exceeding maxVerse.
// Returns { valid: Token[], clipped: bool, firstExcess: number|null }
function sanitiseTokens(tokens, maxVerse) {
  if (!maxVerse || maxVerse >= 999) return { valid: tokens, clipped: false, firstExcess: null };
  const valid = [];
  let clipped = false;
  let firstExcess = null;
  for (const tok of tokens) {
    if (tok.type === 'single') {
      if (tok.v > maxVerse) { clipped = true; firstExcess = tok.v; break; }
      valid.push(tok);
    } else {
      if (tok.from > maxVerse) { clipped = true; firstExcess = tok.from; break; }
      if (tok.to > maxVerse) {
        valid.push({ type: 'range', from: tok.from, to: maxVerse });
        clipped = true; firstExcess = tok.to; break;
      }
      valid.push(tok);
    }
  }
  return { valid, clipped, firstExcess };
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

  if (tokens.length === 0) {
    validationEl.textContent = '';
    validationEl.className   = 'verse-validation';
    return true;
  }

  const { valid, clipped, firstExcess } = sanitiseTokens(tokens, maxVerse);

  if (valid.length === 0) {
    // Every entry is out of range — nothing can be displayed
    validationEl.textContent = `✗ Verse ${firstExcess} exceeds chapter max (${maxVerse})`;
    validationEl.className   = 'verse-validation invalid';
    return false;
  }

  if (clipped) {
    // Partial — some valid verses exist, excess is stripped from output
    validationEl.textContent = `⚠ Verse ${firstExcess} exceeds max (${maxVerse}) — output will use valid verses only`;
    validationEl.className   = 'verse-validation warning';
    return true;
  }

  validationEl.textContent = `✓ Valid — chapter has ${maxVerse} verses`;
  validationEl.className   = 'verse-validation valid';
  return true;
}

// Format verse ref for display, optionally sanitising against maxVerse first.
function formatVerseRef(raw, maxVerse) {
  const { tokens, error } = parseVerseRef(raw);
  if (error || tokens.length === 0) return raw.trim().replace(/[-,.\s]+$/, '');
  const toUse = maxVerse ? sanitiseTokens(tokens, maxVerse).valid : tokens;
  if (toUse.length === 0) return '';
  return toUse.map(tok =>
    tok.type === 'single' ? String(tok.v) : `${tok.from}–${tok.to}`
  ).join(', ');
}

// ── Bible API — Verse Text Lookup ─────────────────────────────────────────────
// Three-tier lookup:
//   Tier 1: bible-api.com (free, no key)      — KJV, ASV, WEB, YLT, DARBY, BBE
//   Tier 2: rest.api.bible (API key)           — AMP, MSG, NASB, NASB95, LSV
//   Tier 3: bible.helloao.org (free, no key)   — BSB
//   Fallback: ASV via Tier 1 (reference-only) — unsupported translations & NONE
// See data.js for BIBLE_API_MAP, APIBIBLE_IDS, HELLOAO_MAP, and USFM_CODES.

const APIBIBLE_BASE = 'https://rest.api.bible/v1';
const APIBIBLE_KEY  = '8LWqzQ47HMAtKGhfXVY2K';
const HELLOAO_BASE  = 'https://bible.helloao.org/api';

// Chapter-level verse cache for api.bible (one fetch per chapter, not per verse)
const apiBibleChapterCache = {};

// Cache size guards — prevent unbounded growth during long sessions
const MAX_VERSE_CACHE   = 200;
const MAX_CHAPTER_CACHE = 40;
function pruneCacheIfNeeded(cache, max) {
  const keys = Object.keys(cache);
  if (keys.length >= max) delete cache[keys[0]];  // evict oldest (insertion order)
}

// ── Superscript verse number helpers ──────────────────────────────────────────
const _SUPER_DIGITS = ['⁰','¹','²','³','⁴','⁵','⁶','⁷','⁸','⁹'];
function toSuperNum(n) {
  return String(n).split('').map(d => _SUPER_DIGITS[+d]).join('');
}
function countTokenVerses(tokens) {
  return tokens.reduce((n, t) => n + (t.type === 'single' ? 1 : t.to - t.from + 1), 0);
}

// ── api.bible chapter JSON verse extractor ────────────────────────────────────
// Walks the USX-style JSON returned by /chapters/{id}?content-type=json and
// builds a verse-number → plain-text map.
function extractApiVerseMap(content) {
  const verseMap = {};
  let curVerse = null;
  function walkNode(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walkNode); return; }
    if (typeof node !== 'object') return;
    if (node.name === 'verse' || node.type === 'verse') {
      const num = parseInt(node.number ?? node.attrs?.number ?? '', 10);
      if (num > 0) curVerse = num;
    }
    if (node.type === 'text' && typeof node.text === 'string' && curVerse !== null) {
      verseMap[curVerse] = (verseMap[curVerse] || '') + node.text;
    }
    if (node.items) walkNode(node.items);
  }
  walkNode(content);
  for (const k of Object.keys(verseMap)) verseMap[k] = verseMap[k].replace(/\s+/g, ' ').trim();
  return verseMap;
}

function lookupVerse() {
  const book      = document.getElementById('book').value;
  const chapter   = document.getElementById('chapter').value;
  const verseRaw  = document.getElementById('verse-ref').value.trim();
  const transAbbr = document.getElementById('translation').value;

  if (!chapter || !verseRaw) {
    setLookupStatus('Enter a chapter and verse first.', 'error');
    return;
  }

  const { tokens, error } = parseVerseRef(verseRaw);
  if (error || tokens.length === 0) {
    setLookupStatus('Fix verse reference before looking up.', 'error');
    return;
  }

  // Sanitise tokens against this chapter's verse count
  const bookObj  = BIBLE_BOOKS.find(b => b.name === book);
  const chapIdx  = parseInt(chapter, 10) - 1;
  const maxVerse = bookObj && bookObj.verses ? bookObj.verses[chapIdx] : 999;
  const { valid: validTokens } = sanitiseTokens(tokens, maxVerse);

  if (validTokens.length === 0) {
    setLookupStatus('No valid verse numbers to look up.', 'error');
    return;
  }

  // Determine if this translation has no API support — fall back to ASV for reference
  const isSupported = !!(BIBLE_API_MAP[transAbbr] || APIBIBLE_IDS[transAbbr] || HELLOAO_MAP[transAbbr]);
  const isRefOnly   = (transAbbr === 'NONE') || !isSupported;

  // Canonical cache key. Reference-only lookups share a single ASV-sourced cache entry.
  const verseKey = validTokens.map(t =>
    t.type === 'single' ? String(t.v) : `${t.from}-${t.to}`
  ).join(',');
  const cacheKey = isRefOnly
    ? `${book}|${chapter}|${verseKey}|_REF`
    : `${book}|${chapter}|${verseKey}|${transAbbr}`;

  const cached = verseTextCache[cacheKey];
  if (cached) {
    displayVerseText(cached.text, cached.refOnly);
    return;
  }

  // Verse-number prefix: prepend superscript number when multiple verses are shown
  const showVerseNums = countTokenVerses(validTokens) > 1;
  const prefixed = (num, text) => showVerseNums ? `${toSuperNum(num)} ${text}` : text;

  setLookupStatus('Looking up…', 'loading');

  // ── Tier 1: bible-api.com (free) — also handles reference-only fallback (ASV) ─
  const freeApiTrans = isRefOnly ? 'asv' : BIBLE_API_MAP[transAbbr];
  if (freeApiTrans) {
    const verseParam = validTokens.map(t =>
      t.type === 'single' ? String(t.v) : `${t.from}-${t.to}`
    ).join(',');
    const ref = `${book} ${chapter}:${verseParam}`;
    const url = `https://bible-api.com/${encodeURIComponent(ref)}?translation=${freeApiTrans}`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        let text;
        if (Array.isArray(data.verses) && data.verses.length > 0) {
          text = data.verses.map(v => prefixed(v.verse, v.text.trim())).join(' ');
        } else if (data.text) {
          text = data.text.trim();
        }
        if (!text) throw new Error('No text in response');
        finaliseLookup(cacheKey, text, isRefOnly);
      })
      .catch(err => setLookupStatus(`Lookup failed: ${err.message}`, 'error'));
    return;
  }

  // ── Tier 2: rest.api.bible (API key) — one chapter fetch, then filter verses ─
  // Fetches the full chapter JSON once and caches the verse map, eliminating
  // multiple requests for discontinuous verse selections.
  const apiBibleId = APIBIBLE_IDS[transAbbr];
  if (apiBibleId) {
    const usfmBook = USFM_CODES[book];
    if (!usfmBook) {
      setLookupStatus('Book not recognised for API lookup.', 'error');
      return;
    }

    const chapCacheKey = `${transAbbr}|${book}|${chapter}`;

    function applyVerseMap(verseMap) {
      const parts = [];
      for (const tok of validTokens) {
        if (tok.type === 'single') {
          if (verseMap[tok.v]) parts.push(prefixed(tok.v, verseMap[tok.v]));
        } else {
          for (let i = tok.from; i <= tok.to; i++) {
            if (verseMap[i]) parts.push(prefixed(i, verseMap[i]));
          }
        }
      }
      const text = parts.join(' ');
      if (!text) throw new Error('Verses not found in chapter data');
      finaliseLookup(cacheKey, text);
    }

    if (apiBibleChapterCache[chapCacheKey]) {
      try { applyVerseMap(apiBibleChapterCache[chapCacheKey]); }
      catch (e) { setLookupStatus(e.message, 'error'); }
      return;
    }

    const chapUrl = `${APIBIBLE_BASE}/bibles/${apiBibleId}/chapters/${usfmBook}.${chapter}` +
      `?content-type=json&include-notes=false&include-titles=false` +
      `&include-chapter-numbers=false&include-verse-numbers=false`;
    fetch(chapUrl, { headers: { 'api-key': APIBIBLE_KEY } })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        const verseMap = extractApiVerseMap(data?.data?.content || []);
        pruneCacheIfNeeded(apiBibleChapterCache, MAX_CHAPTER_CACHE);
        apiBibleChapterCache[chapCacheKey] = verseMap;
        applyVerseMap(verseMap);
      })
      .catch(err => setLookupStatus(`Lookup failed: ${err.message}`, 'error'));
    return;
  }

  // ── Tier 3: bible.helloao.org (free, no key, chapter-level fetch) ────────
  // Returns a full chapter; filter to requested verses and prepend verse numbers.
  const helloaoId = HELLOAO_MAP[transAbbr];
  if (helloaoId) {
    const usfmBook = USFM_CODES[book];
    if (!usfmBook) {
      setLookupStatus('Book not recognised for API lookup.', 'error');
      return;
    }

    const url = `${HELLOAO_BASE}/${helloaoId}/${usfmBook}/${chapter}.json`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        const verses = (data?.chapter?.content || []).filter(c => c.type === 'verse');
        const verseMap = {};
        for (const v of verses) {
          const text = v.content.filter(c => typeof c === 'string').join('').trim();
          if (text) verseMap[v.number] = text;
        }
        const parts = [];
        for (const tok of validTokens) {
          if (tok.type === 'single') {
            if (verseMap[tok.v]) parts.push(prefixed(tok.v, verseMap[tok.v]));
          } else {
            for (let i = tok.from; i <= tok.to; i++) {
              if (verseMap[i]) parts.push(prefixed(i, verseMap[i]));
            }
          }
        }
        const text = parts.join(' ');
        if (!text) throw new Error('No text in response');
        finaliseLookup(cacheKey, text);
      })
      .catch(err => setLookupStatus(`Lookup failed: ${err.message}`, 'error'));
    return;
  }

  // Should not reach here — isRefOnly handles all unsupported translations above
  setLookupStatus('Translation not available for lookup.', 'error');
}

function finaliseLookup(cacheKey, rawText, refOnly = false) {
  const clean = rawText.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  pruneCacheIfNeeded(verseTextCache, MAX_VERSE_CACHE);
  verseTextCache[cacheKey] = { text: clean, refOnly };
  displayVerseText(clean, refOnly);
  setLookupStatus('', '');
}

function setLookupStatus(msg, type) {
  const el = document.getElementById('lookup-status');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'lookup-status' + (type ? ' lookup-' + type : '');
}

function displayVerseText(text, refOnly = false) {
  referenceOnlyLookup = refOnly;
  verseTextCurrent    = text;
  const box     = document.getElementById('verse-text-box');
  const content = document.getElementById('verse-text-content');
  const note    = document.getElementById('verse-ref-note');
  const chk     = document.getElementById('include-verse-text');
  if (!box || !content) return;
  box.style.display   = '';
  content.textContent = text;
  // Reference-only: disable "use as line 2" — text is for verification, not output
  if (chk) { chk.checked = false; chk.disabled = refOnly; }
  if (note) note.style.display = refOnly ? '' : 'none';
  updatePreview();
}

function clearVerseText() {
  referenceOnlyLookup = false;
  verseTextCurrent    = null;
  const box  = document.getElementById('verse-text-box');
  const chk  = document.getElementById('include-verse-text');
  const note = document.getElementById('verse-ref-note');
  if (box)  box.style.display  = 'none';
  if (chk)  { chk.checked = false; chk.disabled = false; }
  if (note) note.style.display = 'none';
  setLookupStatus('', '');
}

// ── Build Ticker Data Object ──────────────────────────────────────────────────
function buildTickerData() {
  const message  = document.getElementById('ticker-message')?.value.trim() || '';
  const label    = document.getElementById('ticker-label')?.value.trim()   || '⚠ ALERT';
  const speed    = parseInt(document.getElementById('ticker-speed')?.value) || 140;
  const style    = document.getElementById('ticker-style')?.value           || 'alert';
  const position = document.getElementById('ticker-position')?.value        || 'bottom';

  // Resolve colors from style preset or custom pickers
  const styleColors = {
    alert:   { bg: '#cc0000', text: '#ffffff' },
    info:    { bg: '#1565c0', text: '#ffffff' },
    warning: { bg: '#e65100', text: '#ffffff' },
    dark:    { bg: '#111111', text: '#eeeeee' },
  };
  const colors = styleColors[style] || {
    bg:   document.getElementById('ticker-bg-color')?.value   || '#cc0000',
    text: document.getElementById('ticker-text-color')?.value || '#ffffff',
  };

  return { message, label, speed, position, bgColor: colors.bg, textColor: colors.text };
}

// ── Build Overlay Data Object ─────────────────────────────────────────────────
function buildOverlayData() {
  if (currentMode === 'ticker') {
    // Ticker mode — return a placeholder for preview only
    return { type: 'ticker', line1: 'Ticker active', line2: '' };
  }
  if (currentMode === 'bible') {
    const book       = document.getElementById('book').value;
    const chapter    = document.getElementById('chapter').value || '';
    const verseRaw   = document.getElementById('verse-ref').value.trim();
    const translAbbr = document.getElementById('translation').value;
    const translation = TRANSLATIONS.find(t => t.abbr === translAbbr);

    // Compute maxVerse so the ref is sanitised before going to output
    const bookObj  = BIBLE_BOOKS.find(b => b.name === book);
    const chapIdx  = parseInt(chapter, 10) - 1;
    const maxVerse = bookObj && bookObj.verses ? bookObj.verses[chapIdx] : 999;

    let ref = book;
    if (chapter) {
      ref += ' ' + chapter;
      if (verseRaw) {
        const sanitised = formatVerseRef(verseRaw, maxVerse);
        if (sanitised) ref += ':' + sanitised;
      }
    }

    const includeText = document.getElementById('include-verse-text')?.checked;
    const showingText = !!(includeText && verseTextCurrent && !referenceOnlyLookup);

    // Append (ABBR) to the reference line when verse text is shown as line 2
    const line1 = (showingText && translAbbr !== 'NONE')
      ? `${ref} (${translAbbr})`
      : ref;

    // line2: verse text → translation full name → empty (when NONE selected)
    let line2;
    if (showingText) {
      line2 = verseTextCurrent;
    } else if (translAbbr === 'NONE') {
      line2 = '';
    } else {
      line2 = translation ? translation.name : translAbbr;
    }

    return { type: 'bible', line1, line2 };
  } else {
    const name  = document.getElementById('speaker-name').value.trim();
    const title = document.getElementById('speaker-title').value.trim();
    return { type: 'speaker', line1: name || '(Speaker name)', line2: title || '' };
  }
}

// ── Preview helpers ───────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function substitutePreviewVars(str, s, data) {
  return str
    .replace(/\{\{line1\}\}/g,       data?.line1 ? escapeHtml(data.line1) : '')
    .replace(/\{\{line2\}\}/g,       data?.line2 ? escapeHtml(data.line2) : '')
    .replace(/\{\{accentColor\}\}/g, s.accentColor || '#C8A951')
    .replace(/\{\{font\}\}/g,        s.font        || 'system-ui')
    .replace(/\{\{logoUrl\}\}/g,     s.logoDataUrl  || '')
    .replace(/\{\{bgUrl\}\}/g,       s.ltBgImage    || '');
}

// ── Preview ───────────────────────────────────────────────────────────────────
function updatePreview() {
  const data     = buildOverlayData();
  const settings = getSettings();
  const useCustom = !!(settings.customTemplate?.enabled && settings.customTemplate?.html);

  const previewWrap   = document.getElementById('preview-wrap');
  const customWrap    = document.getElementById('preview-custom-wrap');
  const customEl      = document.getElementById('preview-custom');
  const tickerPreview = document.getElementById('preview-ticker-wrap');

  // ── Ticker mode preview ─────────────────────────────────────────────────────
  if (currentMode === 'ticker') {
    if (previewWrap)   previewWrap.style.display   = 'none';
    if (customWrap)    customWrap.style.display     = 'none';
    if (tickerPreview) tickerPreview.style.display  = '';
    const td = buildTickerData();
    const bar  = document.getElementById('preview-ticker-bar');
    const badge = document.getElementById('preview-ticker-badge');
    const text  = document.getElementById('preview-ticker-text');
    if (bar)   { bar.style.background = td.bgColor; bar.style.color = td.textColor; }
    if (badge) badge.textContent = td.label;
    if (text)  text.textContent  = td.message || '(ticker message preview)';
    if (tickerPreview) {
      tickerPreview.classList.toggle('pos-top', td.position === 'top');
    }
    return;
  }

  // Hide ticker preview in non-ticker modes
  if (tickerPreview) tickerPreview.style.display = 'none';

  if (useCustom) {
    // ── Custom template preview ───────────────────────────────────────────
    if (previewWrap) previewWrap.style.display = 'none';
    if (customWrap)  customWrap.style.display  = '';
    if (customEl) {
      customEl.innerHTML = substitutePreviewVars(settings.customTemplate.html, settings, data);
    }
    // Inject scoped CSS (risk of collisions is low; custom class names differ from ours)
    let styleEl = document.getElementById('preview-custom-style');
    if (!styleEl) {
      styleEl    = document.createElement('style');
      styleEl.id = 'preview-custom-style';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = substitutePreviewVars(settings.customTemplate.css || '', settings, data);
    return;
  }

  // ── Standard lower-third preview ─────────────────────────────────────────
  if (previewWrap) previewWrap.style.display = '';
  if (customWrap)  customWrap.style.display  = 'none';
  // Clear injected custom CSS when template is disabled
  const staleStyle = document.getElementById('preview-custom-style');
  if (staleStyle) staleStyle.textContent = '';

  document.getElementById('preview-line1').textContent   = data.line1;
  document.getElementById('preview-line2').textContent   = data.line2;
  document.getElementById('preview-line2').style.display = data.line2 ? '' : 'none';

  const lt = document.getElementById('preview-lower-third');
  lt.className = 'lower-third';
  lt.classList.add('style-' + settings.style);

  if (settings.ltBgImage) {
    const bgSizeMap = { stretch: '100% 100%', contain: 'contain', cover: 'cover' };
    lt.style.backgroundImage    = `url('${settings.ltBgImage}')`;
    lt.style.backgroundSize     = bgSizeMap[settings.ltBgSize] || 'cover';
    lt.style.backgroundPosition = settings.ltBgPosition || 'center center';
  } else {
    lt.style.backgroundImage = '';
  }

  // Min-height scaled to the preview viewport (output ref = 1920px wide)
  const previewVpWidth = document.querySelector('.preview-viewport')?.offsetWidth || 320;
  const previewScale   = previewVpWidth / 1920;
  lt.style.minHeight = settings.ltMinHeight
    ? Math.round(settings.ltMinHeight * previewScale) + 'px'
    : '';

  const accent = lt.querySelector('.lt-accent');
  if (accent) accent.style.background = settings.accentColor;

  const logoImg = document.getElementById('preview-logo');
  if (settings.logoDataUrl) {
    logoImg.src = settings.logoDataUrl;
    logoImg.classList.remove('hidden');
    logoImg.classList.toggle('logo-right', settings.logoPosition === 'right');
    logoImg.classList.toggle('logo-left',  settings.logoPosition !== 'right');
    // Scale logo max-height to the preview viewport
    logoImg.style.maxHeight = Math.round((settings.logoSize || 110) * previewScale) + 'px';
    logoImg.style.height    = 'auto';
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
// Preset storage uses global keys (no session ID) so presets are shared across
// all sessions on the same browser. Use Export / Import to move between devices.
const PRESET_KEY_OVERLAY = 'overlayPresets';
const PRESET_KEY_TICKER  = 'tickerPresets';

function loadPresets() {
  try {
    overlayPresets = JSON.parse(localStorage.getItem(PRESET_KEY_OVERLAY) || '[]');
  } catch (_) { overlayPresets = []; }
  try {
    tickerPresets  = JSON.parse(localStorage.getItem(PRESET_KEY_TICKER)  || '[]');
  } catch (_) { tickerPresets  = []; }
  renderPresets();
}

function saveCurrentPreset() {
  let defaultLabel = '';
  if (currentMode === 'bible') {
    const book  = document.getElementById('book').value;
    const ch    = document.getElementById('chapter').value;
    const verse = document.getElementById('verse-ref').value.trim();
    const trans = document.getElementById('translation').value;
    defaultLabel = verse ? `${book} ${ch}:${verse} (${trans})` : `${book} ${ch}`;
  } else if (currentMode === 'speaker') {
    const name  = document.getElementById('speaker-name').value.trim();
    const title = document.getElementById('speaker-title').value.trim();
    defaultLabel = title ? `${name} — ${title}` : name;
  } else {
    // ticker
    const msg = document.getElementById('ticker-message')?.value.trim() || '';
    defaultLabel = msg.slice(0, 40) + (msg.length > 40 ? '…' : '');
  }

  const label = prompt('Preset name:', defaultLabel);
  if (label === null || !label.trim()) return;

  const preset = {
    id:    Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    label: label.trim(),
    mode:  currentMode,
    data:  currentMode === 'bible'
      ? { book:        document.getElementById('book').value,
          chapter:     document.getElementById('chapter').value,
          verse:       document.getElementById('verse-ref').value,
          translation: document.getElementById('translation').value }
      : currentMode === 'speaker'
      ? { name:  document.getElementById('speaker-name').value,
          title: document.getElementById('speaker-title').value }
      : { message:  document.getElementById('ticker-message')?.value || '',
          label:    document.getElementById('ticker-label')?.value   || '⚠ ALERT',
          speed:    document.getElementById('ticker-speed')?.value   || '140',
          style:    document.getElementById('ticker-style')?.value   || 'alert',
          position: document.getElementById('ticker-position')?.value || 'bottom' },
  };

  if (currentMode === 'ticker') {
    tickerPresets.push(preset);
  } else {
    overlayPresets.push(preset);
  }
  savePresetsToStorage();
  renderPresets();
}

function loadPreset(id) {
  // Search in the active preset store
  const store = currentMode === 'ticker' ? tickerPresets : overlayPresets;
  const p = store.find(x => x.id === id);
  if (!p) return;

  if (p.mode !== 'ticker') {
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
  } else {
    if (document.getElementById('ticker-message'))
      document.getElementById('ticker-message').value  = p.data.message  || '';
    if (document.getElementById('ticker-label'))
      document.getElementById('ticker-label').value    = p.data.label    || '⚠ ALERT';
    if (document.getElementById('ticker-speed'))
      document.getElementById('ticker-speed').value    = p.data.speed    || '140';
    if (document.getElementById('ticker-style')) {
      document.getElementById('ticker-style').value    = p.data.style    || 'alert';
      onTickerStyleChange();
    }
    if (document.getElementById('ticker-position'))
      document.getElementById('ticker-position').value = p.data.position || 'bottom';
  }
  updatePreview();
}

function deletePreset(id) {
  if (currentMode === 'ticker') {
    tickerPresets  = tickerPresets.filter(p => p.id !== id);
  } else {
    overlayPresets = overlayPresets.filter(p => p.id !== id);
  }
  savePresetsToStorage();
  renderPresets();
}

function savePresetsToStorage() {
  try { localStorage.setItem(PRESET_KEY_OVERLAY, JSON.stringify(overlayPresets)); } catch (_) {}
  try { localStorage.setItem(PRESET_KEY_TICKER,  JSON.stringify(tickerPresets));  } catch (_) {}
}

// ── Preset Export / Import ─────────────────────────────────────────────────────
function exportPresets() {
  const payload = JSON.stringify({ overlayPresets, tickerPresets }, null, 2);
  const blob    = new Blob([payload], { type: 'application/json' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href        = url;
  a.download    = 'overlay-presets.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importPresets() {
  const input = document.createElement('input');
  input.type  = 'file';
  input.accept = '.json,application/json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        // Merge: add imported presets that don't already exist by id
        const mergeIn = (target, incoming) => {
          const existingIds = new Set(target.map(p => p.id));
          incoming.forEach(p => { if (!existingIds.has(p.id)) target.push(p); });
        };
        if (Array.isArray(data.overlayPresets)) mergeIn(overlayPresets, data.overlayPresets);
        if (Array.isArray(data.tickerPresets))  mergeIn(tickerPresets,  data.tickerPresets);
        savePresetsToStorage();
        renderPresets();
        const countO = Array.isArray(data.overlayPresets) ? data.overlayPresets.length : 0;
        const countT = Array.isArray(data.tickerPresets)  ? data.tickerPresets.length  : 0;
        alert(`Imported ${countO} overlay preset(s) and ${countT} ticker preset(s).`);
      } catch (_) {
        alert('Import failed — file does not appear to be a valid presets export.');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function renderPresets() {
  const isTicker = currentMode === 'ticker';

  // Update section label
  const labelEl = document.getElementById('presets-label');
  if (labelEl) labelEl.textContent = isTicker ? 'Ticker Presets' : 'Reference & Speaker Presets';

  // Show / hide the correct list
  const overlayList = document.getElementById('presets-list-overlay');
  const tickerList  = document.getElementById('presets-list-ticker');
  if (overlayList) overlayList.style.display = isTicker ? 'none' : '';
  if (tickerList)  tickerList.style.display  = isTicker ? ''     : 'none';

  const list  = isTicker ? tickerList  : overlayList;
  const empty = document.getElementById(isTicker ? 'presets-empty-ticker' : 'presets-empty-overlay');
  const store = isTicker ? tickerPresets : overlayPresets;
  if (!list) return;

  list.querySelectorAll('.preset-chip').forEach(el => el.remove());

  if (store.length === 0) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  store.forEach(p => {
    const chip = document.createElement('div');
    chip.className  = 'preset-chip';
    chip.dataset.id = p.id;

    const loadBtn = document.createElement('button');
    loadBtn.className   = 'preset-load';
    loadBtn.textContent = p.label;
    if (p.mode === 'bible') {
      loadBtn.title = `${p.data.book} ${p.data.chapter}:${p.data.verse} (${p.data.translation})`;
    } else if (p.mode === 'speaker') {
      loadBtn.title = `${p.data.name}${p.data.title ? ' — ' + p.data.title : ''}`;
    } else {
      loadBtn.title = p.data.message?.slice(0, 60) || '';
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
  if (currentMode === 'ticker') {
    const td = buildTickerData();
    if (!td.message) return;
    broadcast({ action: 'show-ticker', data: td });
    programTickerData = td;
    programTickerLive = true;
    setTickerStatus(true);
    updateProgramMonitor();
    return;
  }
  const data     = buildOverlayData();
  const settings = getSettings();
  broadcast({ action: 'show', data, settings });
  programOverlayData     = data;
  programOverlaySettings = settings;
  programOverlayLive     = true;
  setOverlayStatus(true);
  updateProgramMonitor();
  updatePreview();
}

function sendClear() {
  if (currentMode === 'ticker') {
    broadcast({ action: 'clear-ticker' });
    programTickerData = null;
    programTickerLive = false;
    setTickerStatus(false);
    updateProgramMonitor();
    return;
  }
  broadcast({ action: 'clear' });
  programOverlayData     = null;
  programOverlaySettings = null;
  programOverlayLive     = false;
  setOverlayStatus(false);
  updateProgramMonitor();
}

function setOverlayStatus(visible) {
  overlayVisible = visible;
  const anyLive = visible || tickerActive;
  const pill = document.getElementById('status-pill');
  pill.className   = 'status-pill ' + (anyLive ? 'status-live' : 'status-off');
  pill.textContent = visible && tickerActive ? 'LIVE + TICKER'
                   : visible                 ? 'LIVE'
                   : tickerActive            ? 'TICKER LIVE'
                   :                          'OFF AIR';
  document.getElementById('monitor-program-block')?.classList.toggle('live', anyLive);
}

function setTickerStatus(live) {
  tickerActive = live;
  const anyLive = overlayVisible || live;
  const pill = document.getElementById('status-pill');
  pill.className   = 'status-pill ' + (anyLive ? 'status-live' : 'status-off');
  pill.textContent = overlayVisible && live ? 'LIVE + TICKER'
                   : live                   ? 'TICKER LIVE'
                   : overlayVisible         ? 'LIVE'
                   :                          'OFF AIR';
  document.getElementById('monitor-program-block')?.classList.toggle('live', anyLive);
}

// ── Program Monitor Renderer ──────────────────────────────────────────────────
// Renders a frozen snapshot of what is currently live into the PGM viewport.
function updateProgramMonitor() {
  const pgmWrap        = document.getElementById('program-wrap');
  const pgmLt          = document.getElementById('program-lower-third');
  const pgmLine1       = document.getElementById('program-line1');
  const pgmLine2       = document.getElementById('program-line2');
  const pgmAccent      = document.getElementById('program-accent');
  const pgmLogo        = document.getElementById('program-logo');
  const pgmLtText      = document.getElementById('program-lt-text');
  const pgmTickerWrap  = document.getElementById('program-ticker-wrap');
  const pgmTickerBar   = document.getElementById('program-ticker-bar');
  const pgmTickerBadge = document.getElementById('program-ticker-badge');
  const pgmTickerText  = document.getElementById('program-ticker-text');
  const offAir         = document.getElementById('program-off-air');

  const anythingLive = programOverlayLive || programTickerLive;
  if (offAir) offAir.style.display = anythingLive ? 'none' : '';

  // ── Overlay (lower-third or speaker) ───────────────────────────────────────
  if (programOverlayLive && programOverlayData) {
    if (pgmWrap) pgmWrap.style.display = '';

    if (pgmLine1) pgmLine1.textContent = programOverlayData.line1 || '';
    if (pgmLine2) {
      pgmLine2.textContent   = programOverlayData.line2 || '';
      pgmLine2.style.display = programOverlayData.line2 ? '' : 'none';
    }

    const s = programOverlaySettings;
    if (s) {
      if (pgmLt)     pgmLt.className            = 'lower-third style-' + (s.style || 'classic');
      if (pgmAccent) pgmAccent.style.background  = s.accentColor || '#C8A951';
      if (pgmLtText) {
        pgmLtText.style.fontFamily = s.font      || 'system-ui';
        pgmLtText.style.textAlign  = s.textAlign || 'center';
      }
      if (pgmLogo) {
        if (s.logoDataUrl) { pgmLogo.src = s.logoDataUrl; pgmLogo.classList.remove('hidden'); }
        else                               pgmLogo.classList.add('hidden');
      }
    }
  } else {
    if (pgmWrap) pgmWrap.style.display = 'none';
  }

  // ── Ticker ─────────────────────────────────────────────────────────────────
  if (programTickerLive && programTickerData) {
    if (pgmTickerWrap) pgmTickerWrap.style.display = '';
    const td = programTickerData;
    if (pgmTickerBar) {
      pgmTickerBar.style.background = td.bgColor   || '#cc0000';
      pgmTickerBar.style.color      = td.textColor || '#ffffff';
    }
    if (pgmTickerBadge) pgmTickerBadge.textContent = td.label   || '⚠ ALERT';
    if (pgmTickerText)  pgmTickerText.textContent  = td.message || '';
    if (pgmTickerWrap)  pgmTickerWrap.classList.toggle('pos-top', td.position === 'top');
  } else {
    if (pgmTickerWrap) pgmTickerWrap.style.display = 'none';
  }
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

// ── Copy Output Link ──────────────────────────────────────────────────────────
// Copies the output.html URL (with session ID and current origin/path) so the
// operator can paste it into a TV browser or another device on the same network.
function copyOutputLink() {
  const outputUrl = location.origin + location.pathname.replace(/index\.html$/, '').replace(/[^/]*$/, '')
    + 'output.html?session=' + SESSION_ID;
  navigator.clipboard.writeText(outputUrl).then(() => {
    const btn = document.getElementById('btn-session-id');
    if (!btn) return;
    btn.classList.add('copied');
    const span = document.getElementById('session-id-text');
    const prev = span ? span.textContent : '';
    if (span) span.textContent = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      if (span) span.textContent = prev;
    }, 1800);
  }).catch(() => {
    // Fallback for browsers that deny clipboard without HTTPS
    prompt('Copy this output URL:', location.origin + location.pathname.replace(/index\.html$/, '').replace(/[^/]*$/, '') + 'output.html?session=' + SESSION_ID);
  });
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
let wsRetryDelay = 5000;   // starts at 5 s; doubles on each failure, caps at 60 s

function initWebSocket() {
  if (location.protocol === 'file:') return;   // WS only available on http://

  const url = `ws://${location.hostname}:${WS_PORT}?session=${SESSION_ID}&role=control`;
  try {
    ws = new WebSocket(url);
    ws.onopen    = () => { wsRetryDelay = 5000; setWsIndicator('online'); };
    ws.onclose   = () => {
      ws = null;
      setWsIndicator('offline');
      setTimeout(initWebSocket, wsRetryDelay);
      wsRetryDelay = Math.min(wsRetryDelay * 2, 60000);
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
    ltBgSize:      document.getElementById('lt-bg-size')?.value       || 'cover',
    ltBgPosition:  document.getElementById('lt-bg-position')?.value   || 'center center',
    ltMinHeight:   parseInt(document.getElementById('lt-min-height')?.value || '0'),
    logoDataUrl:   logoDataUrl,
    logoPosition:  document.getElementById('logo-position')?.value    || 'left',
    logoSize:      parseInt(document.getElementById('logo-size')?.value || '110'),
    customTemplate: {
      enabled: document.getElementById('use-custom-template')?.checked || false,
      html:    document.getElementById('template-html')?.value         || '',
      css:     document.getElementById('template-css')?.value          || '',
    },
    showSessionWatermark: document.getElementById('show-session-watermark')?.checked || false,
  };
}

function onSettingsChange() {
  updatePreview();
  const settings = getSettings();
  broadcast({ action: 'settings', settings });
  persistSettings(settings);
  // Toggle transparent-mode helper note
  const note = document.getElementById('chroma-transparent-note');
  if (note) note.style.display = (settings.chroma === 'transparent') ? '' : 'none';
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

    if (saved.logoSize !== undefined) {
      const el = document.getElementById('logo-size');
      if (el) { el.value = saved.logoSize; document.getElementById('logo-size-val').textContent = saved.logoSize + 'px'; }
    }
    if (saved.ltBgSize)     { const el = document.getElementById('lt-bg-size');     if (el) el.value = saved.ltBgSize; }
    if (saved.ltBgPosition) { const el = document.getElementById('lt-bg-position'); if (el) el.value = saved.ltBgPosition; }
    if (saved.ltMinHeight !== undefined) {
      const el = document.getElementById('lt-min-height');
      if (el) { el.value = saved.ltMinHeight; document.getElementById('lt-min-height-val').textContent = saved.ltMinHeight > 0 ? saved.ltMinHeight + 'px' : 'auto'; }
    }

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

    // Restore watermark toggle
    if (saved.showSessionWatermark !== undefined) {
      const el = document.getElementById('show-session-watermark');
      if (el) el.checked = saved.showSessionWatermark;
    }

    // Restore transparent note visibility after chroma is restored
    const restoredChroma = document.querySelector('input[name="chroma"]:checked')?.value;
    const chromaNote = document.getElementById('chroma-transparent-note');
    if (chromaNote) chromaNote.style.display = (restoredChroma === 'transparent') ? '' : 'none';

    // Restore images
    const savedLtBg = localStorage.getItem('overlayLtBg-' + SESSION_ID);
    if (savedLtBg) { ltBgDataUrl = savedLtBg; restoreLtBgUI(savedLtBg); }

    const savedLogo = localStorage.getItem('overlayLogo-' + SESSION_ID);
    if (savedLogo) { logoDataUrl = savedLogo; restoreLogoUI(savedLogo); }

  } catch (_) {}
}

// ── Slider label helpers ──────────────────────────────────────────────────────
function onLogoSizeInput() {
  const v = document.getElementById('logo-size')?.value;
  const label = document.getElementById('logo-size-val');
  if (label && v !== undefined) label.textContent = v + 'px';
}

function onLtMinHeightInput() {
  const v = parseInt(document.getElementById('lt-min-height')?.value || '0');
  const label = document.getElementById('lt-min-height-val');
  if (label) label.textContent = v > 0 ? v + 'px' : 'auto';
}

// ── Custom Template Examples ──────────────────────────────────────────────────
// Template variables: {{line1}} {{line2}} {{accentColor}} {{font}}
//                     {{logoUrl}} (logo data-URL)  {{bgUrl}} (bg image data-URL)

const TEMPLATE_EXAMPLES = {

  // ── 1. Classic Dark ─────────────────────────────────────────────────────────
  'classic': {
    html: `<div class="t-classic">
  <div class="t-classic-accent"></div>
  <div class="t-classic-text">
    <div class="t-classic-line1">{{line1}}</div>
    <div class="t-classic-line2">{{line2}}</div>
  </div>
</div>`,
    css: `.t-classic {
  display: flex;
  align-items: stretch;
  background: rgba(0,0,0,.88);
  border-radius: 3px;
  overflow: hidden;
  box-shadow: 0 4px 32px rgba(0,0,0,.6);
  font-family: {{font}};
}
.t-classic-accent { width: 8px; background: {{accentColor}}; flex-shrink: 0; }
.t-classic-text { display: flex; flex-direction: column; justify-content: center; padding: 18px 28px; gap: 4px; }
.t-classic-line1 { font-size: 52px; font-weight: 700; color: #fff; line-height: 1.15; }
.t-classic-line2 { font-size: 34px; font-weight: 400; color: rgba(255,255,255,.75); }`,
  },

  // ── 2. Background Image ──────────────────────────────────────────────────────
  // Requires a lower-third background image to be loaded (uses {{bgUrl}}).
  'bg-image': {
    html: `<div class="t-bgimg" style="background-image:url('{{bgUrl}}')">
  <div class="t-bgimg-inner">
    <div class="t-bgimg-line1">{{line1}}</div>
    <div class="t-bgimg-line2">{{line2}}</div>
  </div>
</div>`,
    css: `.t-bgimg {
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  min-height: 130px;
  display: flex;
  align-items: flex-end;
  border-radius: 3px;
  overflow: hidden;
  position: relative;
  font-family: {{font}};
}
.t-bgimg::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, rgba(0,0,0,.85) 0%, rgba(0,0,0,.35) 55%, rgba(0,0,0,.05) 100%);
}
.t-bgimg-inner { position: relative; padding: 18px 28px; }
.t-bgimg-line1 { font-size: 52px; font-weight: 700; color: #fff; text-shadow: 0 2px 12px rgba(0,0,0,.8); line-height: 1.15; }
.t-bgimg-line2 { font-size: 34px; font-weight: 400; color: rgba(255,255,255,.88); text-shadow: 0 2px 8px rgba(0,0,0,.7); }`,
  },

  // ── 3. Logo + Dark Bar ───────────────────────────────────────────────────────
  // Requires a logo to be loaded (uses {{logoUrl}}).
  'logo-bar': {
    html: `<div class="t-lb">
  <div class="t-lb-logo-col">
    <img src="{{logoUrl}}" class="t-lb-logo" alt="" />
  </div>
  <div class="t-lb-rule" style="background:{{accentColor}}"></div>
  <div class="t-lb-text" style="font-family:{{font}}">
    <div class="t-lb-line1">{{line1}}</div>
    <div class="t-lb-line2">{{line2}}</div>
  </div>
</div>`,
    css: `.t-lb {
  display: flex;
  align-items: stretch;
  background: rgba(0,0,0,.88);
  border-radius: 3px;
  overflow: hidden;
  box-shadow: 0 4px 32px rgba(0,0,0,.6);
  min-height: 110px;
}
.t-lb-logo-col {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 18px;
  background: rgba(0,0,0,.3);
  flex-shrink: 0;
}
.t-lb-logo { max-height: 80px; max-width: 160px; object-fit: contain; display: block; }
.t-lb-rule { width: 4px; background: {{accentColor}}; flex-shrink: 0; }
.t-lb-text { display: flex; flex-direction: column; justify-content: center; padding: 16px 24px; gap: 4px; flex: 1; }
.t-lb-line1 { font-size: 52px; font-weight: 700; color: #fff; line-height: 1.15; }
.t-lb-line2 { font-size: 34px; font-weight: 400; color: rgba(255,255,255,.75); }`,
  },

  // ── 4. Minimal Light ─────────────────────────────────────────────────────────
  'light': {
    html: `<div class="t-light">
  <div class="t-light-rule" style="background:{{accentColor}}"></div>
  <div class="t-light-body" style="font-family:{{font}}">
    <div class="t-light-line1">{{line1}}</div>
    <div class="t-light-line2">{{line2}}</div>
  </div>
</div>`,
    css: `.t-light {
  display: flex;
  align-items: stretch;
  background: rgba(255,255,255,.93);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-radius: 3px;
  overflow: hidden;
  box-shadow: 0 4px 24px rgba(0,0,0,.4);
}
.t-light-rule { width: 8px; background: {{accentColor}}; flex-shrink: 0; }
.t-light-body { display: flex; flex-direction: column; justify-content: center; padding: 16px 28px; gap: 4px; }
.t-light-line1 { font-size: 52px; font-weight: 700; color: #111; line-height: 1.15; }
.t-light-line2 { font-size: 34px; font-weight: 400; color: rgba(0,0,0,.6); }`,
  },

  // ── 5. Scripture Scroll ──────────────────────────────────────────────────────
  'scroll': {
    html: `<div class="t-scroll">
  <div class="t-scroll-rule" style="background:{{accentColor}}"></div>
  <div class="t-scroll-body" style="font-family:{{font}}">
    <div class="t-scroll-line1">{{line1}}</div>
    <div class="t-scroll-sep" style="background:{{accentColor}}"></div>
    <div class="t-scroll-line2">{{line2}}</div>
  </div>
  <div class="t-scroll-rule" style="background:{{accentColor}}"></div>
</div>`,
    css: `.t-scroll {
  display: flex;
  flex-direction: column;
  background: rgba(10,8,6,.9);
  border-radius: 2px;
  overflow: hidden;
  box-shadow: 0 4px 32px rgba(0,0,0,.7);
}
.t-scroll-rule { height: 3px; flex-shrink: 0; }
.t-scroll-body { padding: 18px 48px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.t-scroll-line1 { font-size: 52px; font-weight: 600; color: #fff; text-align: center; line-height: 1.15; letter-spacing: .02em; }
.t-scroll-sep   { width: 60px; height: 1px; }
.t-scroll-line2 { font-size: 28px; font-weight: 300; color: rgba(255,255,255,.75); text-align: center; letter-spacing: .08em; text-transform: uppercase; }`,
  },

};

function loadTemplate(name) {
  const tmpl = TEMPLATE_EXAMPLES[name] || TEMPLATE_EXAMPLES['classic'];
  const htmlEl = document.getElementById('template-html');
  const cssEl  = document.getElementById('template-css');
  if (htmlEl) htmlEl.value = tmpl.html;
  if (cssEl)  cssEl.value  = tmpl.css;
  onSettingsChange();
}

// Keep old name as alias so any saved references still work
function resetTemplate() { loadTemplate('classic'); }

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
  document.getElementById('lt-bg-name').textContent           = fileName || 'Custom background loaded';
  document.getElementById('lt-bg-clear').style.display        = '';
  document.getElementById('lt-bg-preview-wrap').style.display = '';
  document.getElementById('lt-bg-preview').src                = dataUrl;
  document.getElementById('bg-fit-controls').style.display    = '';
}

function clearLtBg() {
  ltBgDataUrl = null;
  document.getElementById('lt-bg-file').value                 = '';
  document.getElementById('lt-bg-name').textContent           = 'No image selected';
  document.getElementById('lt-bg-clear').style.display        = 'none';
  document.getElementById('lt-bg-preview-wrap').style.display = 'none';
  document.getElementById('lt-bg-preview').src                = '';
  document.getElementById('bg-fit-controls').style.display    = 'none';
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
      case 't': case 'T': setMode('ticker');                         break;
      case 'o': case 'O': openOutputWindow();                        break;
    }
  });
}
