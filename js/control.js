// ─────────────────────────────────────────────────────────────────────────────
// control.js  —  Operator Control Panel Logic
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Session ID ────────────────────────────────────────────────────────────────
// Each browser tab gets its own session ID so multiple operators can run
// independent control panels with isolated output windows simultaneously.
// The ID is stored in the URL (?session=...) so it survives page reloads.
function sanitizeSessionId(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 40);
}

function makeRandomSessionId() {
  return Math.random().toString(36).slice(2, 9);
}

function showSessionIdModal(suggested) {
  return new Promise((resolve) => {
    const modal = document.getElementById('session-modal');
    const input = document.getElementById('session-modal-input');
    const okBtn = document.getElementById('session-modal-ok');
    const cancelBtn = document.getElementById('session-modal-cancel');
    const errorEl = document.getElementById('session-modal-error');
    if (!modal || !input || !okBtn || !cancelBtn || !errorEl) {
      resolve(suggested);
      return;
    }

    input.value = suggested;
    errorEl.textContent = '';
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);

    const cleanup = () => {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKeyDown);
    };

    const onOk = () => {
      const value = sanitizeSessionId(input.value);
      if (!value) {
        errorEl.textContent = 'Please enter a valid Session ID.';
        input.focus();
        return;
      }
      cleanup();
      resolve(value);
    };

    const onCancel = () => {
      cleanup();
      resolve(suggested);
    };

    const onKeyDown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        onOk();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        onCancel();
      }
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKeyDown);
  });
}

async function getOrCreateSessionId() {
  const params = new URLSearchParams(location.search);
  const remembered = (() => {
    try { return sanitizeSessionId(localStorage.getItem('overlayLastSessionId')); } catch (_) { return ''; }
  })();

  let id = sanitizeSessionId(params.get('session'));
  if (!id) {
    const suggested = remembered || makeRandomSessionId();
    id = await showSessionIdModal(suggested);
  }

  params.set('session', id);
  history.replaceState({}, '', '?' + params.toString());
  try { localStorage.setItem('overlayLastSessionId', id); } catch (_) {}
  return id;
}
let SESSION_ID = '';

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
let templatePresets = [];
let settingsProfiles = [];
let overlayModeSettings = { bible: null, speaker: null };
let defaultOverlayModeSettings = null;
let activeOverlaySettingsMode = 'bible';

// Communication channels (BroadcastChannel primary; localStorage fallback)
// All keys are namespaced with SESSION_ID so multiple users don't collide.
let CHANNEL_NAME = '';
let LS_KEY       = '';
const GLOBAL_TEMPLATE_KEY = 'overlayCustomTemplateGlobal';
const OVERLAY_MODE_SETTINGS_KEY_PREFIX = 'overlayModeSettings-';
let ATEM_EXPORT_PIN_KEY = '';
let channel        = null;

function configureSessionKeys(sessionId) {
  SESSION_ID = sessionId;
  CHANNEL_NAME = 'reference-overlay-' + SESSION_ID;
  LS_KEY = 'referenceOverlayState-' + SESSION_ID;
  ATEM_EXPORT_PIN_KEY = 'overlayAtemExportPin-' + SESSION_ID;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (_) {
    channel = null;
  }
}

// WebSocket client — only active when served via http:// (server.js mode)
let ws      = null;
const FONT_FALLBACK_STACK = "'Noto Sans Devanagari', 'Noto Sans Tamil', 'Noto Sans Telugu', 'Noto Sans Malayalam', 'Noto Sans Kannada', sans-serif";
const LANGUAGE_DEFAULT_FONT = {
  en: "'Cinzel', serif",
  hi: "'Noto Sans Devanagari', sans-serif",
  ta: "'Noto Sans Tamil', sans-serif",
  te: "'Noto Sans Telugu', sans-serif",
  ml: "'Noto Sans Malayalam', sans-serif",
  kn: "'Noto Sans Kannada', sans-serif",
};
const FONT_WEIGHT_LABELS = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semi Bold',
  700: 'Bold',
  800: 'Extra Bold',
  900: 'Black',
};
const FALLBACK_FONT_WEIGHTS = [400, 700];
const DEFAULT_TICKER_MESSAGE = 'The Live Stream has been restored. Thank you for your patience, and our sincere apologies for the interruption.';
const DEFAULT_TICKER_STYLE = 'dark';
const DEFAULT_TEXT_EFFECTS = {
  line1: {
    fontWeight: 700,
    italic: false,
    fontScale: 1,
    useCustomColor: false,
    fontColor: '#ffffff',
    shadowEnabled: true,
    shadowColor: '#000000',
    shadowAngle: 120,
    shadowDepth: 6,
    shadowBlur: 8,
    shadowOpacity: 0.85,
    strokeEnabled: false,
    strokeColor: '#000000',
    strokeWidth: 0,
  },
  line2: {
    fontWeight: 400,
    italic: false,
    fontScale: 1,
    useCustomColor: false,
    fontColor: '#ffffff',
    shadowEnabled: true,
    shadowColor: '#000000',
    shadowAngle: 120,
    shadowDepth: 4,
    shadowBlur: 6,
    shadowOpacity: 0.75,
    strokeEnabled: false,
    strokeColor: '#000000',
    strokeWidth: 0,
  },
};
let renderSyncRaf = 0;
let monitorResizeObserver = null;

// ── Initialise ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const sessionId = await getOrCreateSessionId();
  configureSessionKeys(sessionId);

  populateBooks();
  populateTranslations();
  populateReferenceLanguages();
  populateFonts();
  defaultOverlayModeSettings = pickModeDependentSettings(getSettings());
  overlayModeSettings.bible = JSON.parse(JSON.stringify(defaultOverlayModeSettings));
  overlayModeSettings.speaker = JSON.parse(JSON.stringify(defaultOverlayModeSettings));
  loadSettings();
  syncBookNameDisplayOption();
  loadPresets();
  loadSettingsProfiles();
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
  const savedPin = (() => { try { return localStorage.getItem(ATEM_EXPORT_PIN_KEY) === '1'; } catch (_) { return false; } })();
  updateAtemExportUiState(savedPin);
  setOutputSetupTab('browser');

  // Restore transparent note visibility
  const savedChroma = document.querySelector('input[name="chroma"]:checked')?.value;
  const note = document.getElementById('chroma-transparent-note');
  if (note) note.style.display = (savedChroma === 'transparent') ? '' : 'none';

  initSettingsPanelUi();
  initSettingsSubsectionState();
  switchTextEffectsLine('line1');
  initMonitorRenderSync();
  scheduleMonitorRenderSync();
  // Ensure output windows follow the control's current live state after reload.
  setTimeout(() => syncCurrentStateToOutputs(), 120);
});

// ── Populate Dropdowns ────────────────────────────────────────────────────────
function populateBooks() {
  const otGroup = document.getElementById('optgroup-ot');
  const ntGroup = document.getElementById('optgroup-nt');
  BIBLE_BOOKS.forEach(b => {
    const opt = document.createElement('option');
    opt.value        = b.name;
    opt.dataset.abbr = b.abbr;
    opt.dataset.enName = b.name;
    opt.textContent  = b.name;
    (b.testament === 'OT' ? otGroup : ntGroup).appendChild(opt);
  });
  const bookEl = document.getElementById('book');
  bookEl.value = 'John';
  populateChapters('John', 3);
  document.getElementById('verse-ref').value = '16-18';
  updateBookOptionLabels();
}

function populateReferenceLanguages() {
  const sel = document.getElementById('reference-language');
  if (!sel) return;
  sel.innerHTML = '';
  REFERENCE_LANGUAGES.forEach(lang => {
    const opt = document.createElement('option');
    opt.value = lang.value;
    opt.textContent = lang.label;
    sel.appendChild(opt);
  });
  sel.value = 'en';
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
  sel.innerHTML = '';

  // "None" — hides the translation name from output (line2 will be empty)
  const noneOpt = document.createElement('option');
  noneOpt.value       = 'NONE';
  noneOpt.textContent = '— None (hide translation) —';
  sel.appendChild(noneOpt);

  const langLabel = {
    en: 'English',
    hi: 'Hindi (हिन्दी)',
    ta: 'Tamil (தமிழ்)',
    te: 'Telugu (తెలుగు)',
    ml: 'Malayalam (മലയാളം)',
    kn: 'Kannada (ಕನ್ನಡ)',
  };

  function hasFreeSource(t) {
    return !!(
      ((t.bg && canUseBibleGatewayProxy())) ||
      BIBLE_API_MAP[t.abbr] ||
      HELLOAO_MAP[t.abbr] ||
      (canUseBibleGatewayProxy() && YOUVERSION_MAP[t.abbr])
    );
  }
  function hasPremiumSource(t) {
    return !!APIBIBLE_IDS[t.abbr];
  }
  function makeOption(t) {
    const opt = document.createElement('option');
    opt.value       = t.abbr;
    opt.textContent = `${t.abbr} — ${t.name}`;
    return opt;
  }

  function makeGroup(label, list) {
    if (!list.length) return;
    const grp = document.createElement('optgroup');
    grp.label = label;
    list.forEach(t => grp.appendChild(makeOption(t)));
    sel.appendChild(grp);
  }

  const langOrder = ['en', 'hi', 'ta', 'te', 'ml', 'kn'];
  const byLang = {};
  TRANSLATIONS.forEach(t => {
    const lang = t.lang || 'en';
    if (!byLang[lang]) byLang[lang] = [];
    byLang[lang].push(t);
  });

  langOrder.forEach(lang => {
    const list = byLang[lang] || [];
    if (!list.length) return;
    const free = list.filter(t => hasFreeSource(t));
    const premium = list.filter(t => hasPremiumSource(t));
    const refOnly = list.filter(t => !hasFreeSource(t) && !hasPremiumSource(t));
    makeGroup(`${langLabel[lang] || lang} — Lookup Available (Free)`, free);
    makeGroup(`${langLabel[lang] || lang} — Lookup Available (Premium)`, premium);
    makeGroup(`${langLabel[lang] || lang} — Reference Only`, refOnly);
  });

  sel.value = 'NONE';
}

function populateFonts() {
  const line1Sel = document.getElementById('line1-font-select');
  const line2Sel = document.getElementById('line2-font-select');
  populateFontSelect(line1Sel, "'Cinzel', serif");
  populateFontSelect(line2Sel, "'Cinzel', serif");
  populateFontWeightSelect('line1', DEFAULT_TEXT_EFFECTS.line1.fontWeight);
  populateFontWeightSelect('line2', DEFAULT_TEXT_EFFECTS.line2.fontWeight);
}

function populateFontSelect(sel, defaultValue) {
  if (!sel) return;
  sel.innerHTML = '';
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
  sel.value = defaultValue;
}

function getFontOptionByValue(value) {
  return FONT_OPTIONS.find(f => f.value === value) || null;
}

function getSupportedWeightsForFont(fontValue) {
  const match = getFontOptionByValue(fontValue);
  const list = Array.isArray(match?.weights) && match.weights.length
    ? match.weights
    : FALLBACK_FONT_WEIGHTS;
  return Array.from(new Set(list.map(v => parseInt(v, 10)).filter(v => Number.isFinite(v))))
    .sort((a, b) => a - b);
}

function populateFontWeightSelect(lineKey, preferredWeight) {
  const fontSel = document.getElementById(`${lineKey}-font-select`);
  const weightSel = document.getElementById(`${lineKey}-font-weight`);
  if (!fontSel || !weightSel) return;

  const weights = getSupportedWeightsForFont(fontSel.value);
  const desired = parseInt(preferredWeight ?? weightSel.value, 10);
  let nextWeight = weights[0] || 400;
  if (Number.isFinite(desired) && weights.includes(desired)) {
    nextWeight = desired;
  } else if (Number.isFinite(desired) && weights.length) {
    nextWeight = weights.reduce((best, cur) => {
      return Math.abs(cur - desired) < Math.abs(best - desired) ? cur : best;
    }, weights[0]);
  }

  weightSel.innerHTML = '';
  weights.forEach(w => {
    const opt = document.createElement('option');
    opt.value = String(w);
    opt.textContent = `${FONT_WEIGHT_LABELS[w] || 'Weight'} (${w})`;
    if (w === nextWeight) opt.selected = true;
    weightSel.appendChild(opt);
  });
}

function onLineFontChange(lineKey) {
  populateFontWeightSelect(lineKey);
  onSettingsChange();
}

function getReferenceLanguage() {
  return document.getElementById('reference-language')?.value || 'en';
}

function getLocalizedBookName(bookName, langCode) {
  if (!bookName || !langCode || langCode === 'en') return bookName;
  return BOOK_NAME_I18N?.[langCode]?.[bookName] || bookName;
}

function shouldHideEnglishBookName() {
  return !!document.getElementById('hide-english-book-name')?.checked;
}

function syncBookNameDisplayOption() {
  const hideEnglishEl = document.getElementById('hide-english-book-name');
  if (!hideEnglishEl) return;
  const isIndicReference = getReferenceLanguage() !== 'en';
  hideEnglishEl.disabled = !isIndicReference;
  if (!isIndicReference) hideEnglishEl.checked = false;
}

function formatReferenceBookName(bookName, langCode, hideEnglishName = false) {
  if (!bookName) return '';
  if (!langCode || langCode === 'en') return bookName;
  const local = getLocalizedBookName(bookName, langCode);
  if (!local || local === bookName) return bookName;
  return hideEnglishName ? local : `${local} (${bookName})`;
}

function updateBookOptionLabels() {
  const lang = getReferenceLanguage();
  const hideEnglish = shouldHideEnglishBookName();
  const sel = document.getElementById('book');
  if (!sel) return;
  Array.from(sel.options).forEach(opt => {
    const enName = opt.dataset.enName || opt.value;
    if (lang === 'en') {
      opt.textContent = enName;
      return;
    }
    const local = getLocalizedBookName(enName, lang);
    if (!local || local === enName) {
      opt.textContent = enName;
      return;
    }
    opt.textContent = hideEnglish ? local : `${local} (${enName})`;
  });
}

function resolvedFontFamily(fontValue) {
  const raw = (fontValue || '').trim() || "'Cinzel', serif";
  return raw.includes('Noto Sans')
    ? `${raw}, sans-serif`
    : `${raw}, ${FONT_FALLBACK_STACK}`;
}

function maybeApplyLanguageFont(lang, force = false) {
  const line1Sel = document.getElementById('line1-font-select');
  const line2Sel = document.getElementById('line2-font-select');
  if (!line1Sel || !line2Sel) return;
  const currentLine1 = line1Sel.value;
  const currentLine2 = line2Sel.value;
  const next = LANGUAGE_DEFAULT_FONT[lang] || LANGUAGE_DEFAULT_FONT.en;
  if (force || currentLine1 === LANGUAGE_DEFAULT_FONT.en) line1Sel.value = next;
  if (force || currentLine2 === LANGUAGE_DEFAULT_FONT.en) line2Sel.value = next;
  populateFontWeightSelect('line1');
  populateFontWeightSelect('line2');
}

function getLineTextEffect(settings, lineKey) {
  const merged = { ...DEFAULT_TEXT_EFFECTS[lineKey], ...(settings?.textEffects?.[lineKey] || {}) };
  // Backward compatibility with presets saved before explicit enable toggles existed.
  if (typeof merged.strokeEnabled === 'undefined') {
    merged.strokeEnabled = (parseFloat(merged.strokeWidth) || 0) > 0;
  }
  if (typeof merged.shadowEnabled === 'undefined') {
    merged.shadowEnabled = true;
  }
  return merged;
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

function applyLineEffectToEl(el, effect) {
  if (!el || !effect) return;
  el.style.fontWeight = String(effect.fontWeight || '');
  el.style.fontStyle = effect.italic ? 'italic' : '';
  el.style.color = effect.useCustomColor ? (effect.fontColor || '#ffffff') : '';
  const shadowEnabled = effect.shadowEnabled !== false;
  const depth = Math.max(0, parseFloat(effect.shadowDepth) || 0);
  const angle = ((parseFloat(effect.shadowAngle) || 0) % 360) * (Math.PI / 180);
  const blur = Math.max(0, parseFloat(effect.shadowBlur) || 0);
  const opacity = Math.max(0, Math.min(1, parseFloat(effect.shadowOpacity) || 0));
  const x = Math.cos(angle) * depth;
  const y = Math.sin(angle) * depth;
  const shadowColor = hexToRgba(effect.shadowColor, opacity);
  el.style.textShadow = (shadowEnabled && (depth > 0 || blur > 0))
    ? `${x.toFixed(1)}px ${y.toFixed(1)}px ${blur.toFixed(1)}px ${shadowColor}`
    : 'none';

  const strokeEnabled = !!effect.strokeEnabled;
  const strokeWidth = Math.max(0, parseFloat(effect.strokeWidth) || 0);
  el.style.webkitTextStroke = (strokeEnabled && strokeWidth > 0)
    ? `${strokeWidth.toFixed(1)}px ${effect.strokeColor || '#000000'}`
    : '0px transparent';
}

function applyLineTextEffects(line1El, line2El, settings) {
  const l1 = getLineTextEffect(settings, 'line1');
  const l2 = getLineTextEffect(settings, 'line2');
  applyLineEffectToEl(line1El, l1);
  applyLineEffectToEl(line2El, l2);

  if (line1El) {
    line1El.style.fontSize = '';
    const base = parseFloat(getComputedStyle(line1El).fontSize) || 20;
    const scale = Math.max(0.3, parseFloat(l1.fontScale) || 1);
    line1El.style.fontSize = `${(base * scale).toFixed(1)}px`;
  }
  if (line2El) {
    line2El.style.fontSize = '';
    const base = parseFloat(getComputedStyle(line2El).fontSize) || 16;
    const scale = Math.max(0.3, parseFloat(l2.fontScale) || 1);
    line2El.style.fontSize = `${(base * scale).toFixed(1)}px`;
  }
}

// ── Mode Toggle ───────────────────────────────────────────────────────────────
function setMode(mode) {
  if (currentMode === 'bible' || currentMode === 'speaker') {
    storeCurrentModeDependentSettings();
    activeOverlaySettingsMode = currentMode;
  }

  currentMode = mode;

  if (mode === 'bible' || mode === 'speaker') {
    activeOverlaySettingsMode = mode;
    applyModeDependentSettingsToUi(mode);
  }

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
  updateCutToAirButtonState();
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
  autoSyncReferenceLanguageFromTranslation();
  validateVerseInput();
  clearVerseText();
  syncBibleLineOptions();
  updatePreview();
}
function onBibleLineOptionsChange() {
  syncBibleLineOptions();
  updateBookOptionLabels();
  updatePreview();
}
function onReferenceLanguageChange() {
  const lang = getReferenceLanguage();
  syncBookNameDisplayOption();
  updateBookOptionLabels();
  if (lang !== 'en') maybeApplyLanguageFont(lang, false);
  updatePreview();
}
function onSpeakerChange() {
  const speakerNameEl = document.getElementById('speaker-name');
  if (speakerNameEl) speakerNameEl.setCustomValidity('');
  updateCutToAirButtonState();
  updatePreview();
}

function onTickerChange() { updatePreview(); }

function onTickerSizeInput() {
  const h = parseInt(document.getElementById('ticker-bar-height')?.value || '68', 10);
  const t = parseInt(document.getElementById('ticker-font-size')?.value || '28', 10);
  const b = parseInt(document.getElementById('ticker-badge-size')?.value || '22', 10);
  const hVal = document.getElementById('ticker-bar-height-val');
  const tVal = document.getElementById('ticker-font-size-val');
  const bVal = document.getElementById('ticker-badge-size-val');
  if (hVal) hVal.textContent = `${h}px`;
  if (tVal) tVal.textContent = `${t}px`;
  if (bVal) bVal.textContent = `${b}px`;
}

function onLtBgOpacityInput() {
  const v = parseFloat(document.getElementById('lt-bg-opacity')?.value || '0.88').toFixed(2);
  const a = document.getElementById('lt-bg-opacity-val');
  const b = document.getElementById('lt-bg-opacity-display');
  if (a) a.textContent = v;
  if (b) b.textContent = v;
}

function onLtWidthInput() {
  const v = parseInt(document.getElementById('lt-width')?.value || '100', 10);
  const a = document.getElementById('lt-width-val');
  const b = document.getElementById('lt-width-display');
  if (a) a.textContent = `${v}%`;
  if (b) b.textContent = `${v}%`;
}

function onLine2MaxLinesInput() {
  const v = parseInt(document.getElementById('line2-max-lines')?.value || '2', 10);
  const a = document.getElementById('line2-max-lines-val');
  const b = document.getElementById('line2-max-lines-display');
  if (a) a.textContent = String(v);
  if (b) b.textContent = String(v);
}

function onTickerStyleChange() {
  const style  = document.getElementById('ticker-style')?.value;
  const custom = document.getElementById('ticker-custom-colors');
  if (custom) custom.classList.toggle('visible', style === 'custom');
  updatePreview();
}

const MODE_DEPENDENT_SETTING_KEYS = [
  'style', 'accentColor', 'ltBgColor', 'ltBgOpacity', 'ltWidth',
  'line2Multiline', 'line2MaxLines', 'position', 'font', 'line1Font',
  'line2Font', 'textAlign', 'textEffects'
];

function getOverlayStyleModeForEditing() {
  if (currentMode === 'bible' || currentMode === 'speaker') return currentMode;
  return activeOverlaySettingsMode || 'bible';
}

function pickModeDependentSettings(settings) {
  const out = {};
  MODE_DEPENDENT_SETTING_KEYS.forEach((k) => {
    if (settings[k] !== undefined) out[k] = (k === 'textEffects')
      ? JSON.parse(JSON.stringify(settings[k]))
      : settings[k];
  });
  return out;
}

function storeCurrentModeDependentSettings() {
  const mode = getOverlayStyleModeForEditing();
  if (mode !== 'bible' && mode !== 'speaker') return;
  overlayModeSettings[mode] = pickModeDependentSettings(getSettings());
}

function applyModeDependentSettingsToUi(mode) {
  const saved = overlayModeSettings[mode] || defaultOverlayModeSettings;
  if (!saved) return;

  if (saved.style) {
    const el = document.getElementById('style-select');
    if (el) el.value = saved.style;
  }
  if (saved.accentColor) {
    const el = document.getElementById('accent-color');
    if (el) el.value = saved.accentColor;
  }
  if (saved.ltBgColor) {
    const el = document.getElementById('lt-bg-color');
    if (el) el.value = saved.ltBgColor;
  }
  if (saved.ltBgOpacity !== undefined) {
    const el = document.getElementById('lt-bg-opacity');
    if (el) el.value = String(saved.ltBgOpacity);
  }
  if (saved.ltWidth !== undefined) {
    const el = document.getElementById('lt-width');
    if (el) el.value = String(saved.ltWidth);
  }
  if (saved.line2Multiline !== undefined) {
    const el = document.getElementById('line2-multiline');
    if (el) el.checked = !!saved.line2Multiline;
  }
  if (saved.line2MaxLines !== undefined) {
    const el = document.getElementById('line2-max-lines');
    if (el) el.value = String(saved.line2MaxLines);
  }
  if (saved.position) {
    const el = document.getElementById('position-select');
    if (el) el.value = saved.position;
  }

  const legacyFont = saved.font || "'Cinzel', serif";
  const line1Sel = document.getElementById('line1-font-select');
  const line2Sel = document.getElementById('line2-font-select');
  if (line1Sel) line1Sel.value = saved.line1Font || legacyFont;
  if (line2Sel) line2Sel.value = saved.line2Font || saved.line1Font || legacyFont;

  if (saved.textAlign) {
    const r = document.querySelector(`input[name="textAlign"][value="${saved.textAlign}"]`);
    if (r) r.checked = true;
  }

  if (saved.textEffects) {
    setTextEffectsUI(saved.textEffects);
  } else {
    populateFontWeightSelect('line1');
    populateFontWeightSelect('line2');
  }

  onLtBgOpacityInput();
  onLtWidthInput();
  onLine2MaxLinesInput();
  updateTextEffectLabels();
}

function updateCutToAirButtonState() {
  const btn = document.getElementById('btn-show');
  if (!btn) return;
  if (!btn.dataset.defaultTitle) {
    btn.dataset.defaultTitle = btn.title || 'Cut to Air';
  }
  const speakerName = document.getElementById('speaker-name')?.value.trim() || '';
  const mustDisable = currentMode === 'speaker' && !speakerName;
  btn.disabled = mustDisable;
  btn.setAttribute('aria-disabled', mustDisable ? 'true' : 'false');
  btn.title = mustDisable
    ? 'Enter Speaker Name before Cut to Air.'
    : btn.dataset.defaultTitle;
}

function autoSyncReferenceLanguageFromTranslation() {
  const transAbbr = document.getElementById('translation')?.value;
  if (!transAbbr || transAbbr === 'NONE') return;
  const translation = TRANSLATIONS.find(t => t.abbr === transAbbr);
  const lang = translation?.lang;
  if (!lang) return;
  const langSel = document.getElementById('reference-language');
  if (!langSel) return;
  if (langSel.value === 'en') {
    langSel.value = lang;
    syncBookNameDisplayOption();
    updateBookOptionLabels();
    maybeApplyLanguageFont(lang, false);
  }
}

function syncBibleLineOptions() {
  const translation = document.getElementById('translation')?.value || 'NONE';
  const hideLine2El = document.getElementById('hide-translation-line2');
  const includeVerseEl = document.getElementById('include-verse-text');
  const appendAbbrEl = document.getElementById('append-translation-abbr-line1');
  if (!appendAbbrEl) return;

  const hideLine2 = !!hideLine2El?.checked;
  const includeVerse = !!includeVerseEl?.checked;
  const showingVerseText = includeVerse && !!verseTextCurrent && !referenceOnlyLookup;
  const line2ShowsFullTranslation = translation !== 'NONE' && !hideLine2 && !showingVerseText;
  const canAppend = translation !== 'NONE' && (hideLine2 || showingVerseText);

  if (line2ShowsFullTranslation || !canAppend) {
    appendAbbrEl.checked = false;
  }
  appendAbbrEl.disabled = !canAppend;
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
// Five-tier lookup:
//   Tier 0: local /api/verse proxy (BibleGateway scraper via server.js, free)
//   Tier 1: bible-api.com (free, no key)       — KJV, ASV, WEB, YLT, DARBY, BBE
//   Tier 2: bible.helloao.org (free, no key)   — BSB
//   Tier 3: local /api/youversion proxy (free) — mapped translations in YOUVERSION_MAP
//   Tier 4: rest.api.bible (API key)           — AMP, MSG, NASB, NASB95, LSV
//   Fallback: ASV via Tier 1 (reference-only) — unsupported translations & NONE
// See data.js for BIBLE_API_MAP, APIBIBLE_IDS, HELLOAO_MAP, YOUVERSION_MAP, and USFM_CODES.

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

// ── Verse number helpers ──────────────────────────────────────────────────────
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

function canUseBibleGatewayProxy() {
  return location.protocol !== 'file:';
}

function expandVerseTokens(tokens) {
  const verses = [];
  for (const tok of tokens) {
    if (tok.type === 'single') verses.push(tok.v);
    else for (let i = tok.from; i <= tok.to; i++) verses.push(i);
  }
  return verses;
}

async function fetchBibleGatewayText(book, chapter, validTokens, transAbbr, prefixed) {
  const bgVersion = BIBLEGATEWAY_MAP[transAbbr] || transAbbr;
  const verseList = expandVerseTokens(validTokens);
  const parts = [];

  // Fetch each verse individually so we can preserve superscript numbering format.
  for (const verseNum of verseList) {
    const url = `/api/verse?book=${encodeURIComponent(book)}&chapter=${encodeURIComponent(chapter)}&verses=${verseNum}&version=${encodeURIComponent(bgVersion)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`BibleGateway HTTP ${r.status}`);
    const data = await r.json();
    const text = (data?.passage || '').replace(/\s+/g, ' ').trim();
    if (text) parts.push(prefixed(verseNum, text));
  }

  if (!parts.length) throw new Error('No text from BibleGateway');
  return parts.join(' ');
}

async function fetchBibleApiText(book, chapter, validTokens, transAbbr, prefixed, isRefOnly) {
  const freeApiTrans = isRefOnly ? 'asv' : BIBLE_API_MAP[transAbbr];
  if (!freeApiTrans) throw new Error('bible-api not configured for translation');
  const verseParam = validTokens.map(t =>
    t.type === 'single' ? String(t.v) : `${t.from}-${t.to}`
  ).join(',');
  const ref = `${book} ${chapter}:${verseParam}`;
  const url = `https://bible-api.com/${encodeURIComponent(ref)}?translation=${freeApiTrans}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`bible-api HTTP ${r.status}`);
  const data = await r.json();
  if (Array.isArray(data.verses) && data.verses.length > 0) {
    return data.verses.map(v => prefixed(v.verse, v.text.trim())).join(' ');
  }
  if (data.text) return data.text.trim();
  throw new Error('No text in bible-api response');
}

async function fetchApiBibleText(book, chapter, validTokens, transAbbr, prefixed) {
  const apiBibleId = APIBIBLE_IDS[transAbbr];
  if (!apiBibleId) throw new Error('api.bible not configured for translation');
  const usfmBook = USFM_CODES[book];
  if (!usfmBook) throw new Error('Book not recognised for API lookup.');
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
    return text;
  }

  if (apiBibleChapterCache[chapCacheKey]) {
    return applyVerseMap(apiBibleChapterCache[chapCacheKey]);
  }

  const chapUrl = `${APIBIBLE_BASE}/bibles/${apiBibleId}/chapters/${usfmBook}.${chapter}` +
    `?content-type=json&include-notes=false&include-titles=false` +
    `&include-chapter-numbers=false&include-verse-numbers=false`;
  const r = await fetch(chapUrl, { headers: { 'api-key': APIBIBLE_KEY } });
  if (!r.ok) throw new Error(`api.bible HTTP ${r.status}`);
  const data = await r.json();
  const verseMap = extractApiVerseMap(data?.data?.content || []);
  pruneCacheIfNeeded(apiBibleChapterCache, MAX_CHAPTER_CACHE);
  apiBibleChapterCache[chapCacheKey] = verseMap;
  return applyVerseMap(verseMap);
}

async function fetchHelloAoText(book, chapter, validTokens, transAbbr, prefixed) {
  const helloaoId = HELLOAO_MAP[transAbbr];
  if (!helloaoId) throw new Error('helloao not configured for translation');
  const usfmBook = USFM_CODES[book];
  if (!usfmBook) throw new Error('Book not recognised for API lookup.');
  const url = `${HELLOAO_BASE}/${helloaoId}/${usfmBook}/${chapter}.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`helloao HTTP ${r.status}`);
  const data = await r.json();
  const verses = (data?.chapter?.content || []).filter(c => c.type === 'verse');
  const verseMap = {};
  for (const v of verses) {
    const text = v.content
      .filter(c => typeof c === 'string')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
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
  if (!text) throw new Error('No text in helloao response');
  return text;
}

async function fetchYouVersionText(book, chapter, validTokens, transAbbr, prefixed) {
  const yvVersion = YOUVERSION_MAP[transAbbr];
  if (!yvVersion) throw new Error('youversion not configured for translation');
  const bookAlias = USFM_CODES[book];
  if (!bookAlias) throw new Error('Book not recognised for YouVersion lookup.');

  const verseList = expandVerseTokens(validTokens);
  const parts = [];
  for (const verseNum of verseList) {
    const url = `/api/youversion?book=${encodeURIComponent(book)}&book_alias=${encodeURIComponent(bookAlias)}&chapter=${encodeURIComponent(chapter)}&verses=${encodeURIComponent(verseNum)}&version=${encodeURIComponent(yvVersion)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`YouVersion HTTP ${r.status}`);
    const data = await r.json();
    const text = (data?.passage || '').replace(/\s+/g, ' ').trim();
    if (text) parts.push(prefixed(verseNum, text));
  }
  const text = parts.join(' ');
  if (!text) throw new Error('No text in YouVersion response');
  return text;
}

function hasExpectedScript(text, lang) {
  if (!text || !lang || lang === 'en') return true;
  const ranges = {
    hi: /[\u0900-\u097F]/,
    ta: /[\u0B80-\u0BFF]/,
    te: /[\u0C00-\u0C7F]/,
    ml: /[\u0D00-\u0D7F]/,
    kn: /[\u0C80-\u0CFF]/,
  };
  const rx = ranges[lang];
  return rx ? rx.test(text) : true;
}

function getLanguageFallbackAbbrs(requestedAbbr) {
  if (!requestedAbbr || requestedAbbr === 'NONE') return [];
  const tr = TRANSLATIONS.find(t => t.abbr === requestedAbbr);
  const lang = tr?.lang;
  if (!lang || lang === 'en') return [];
  return TRANSLATIONS
    .filter(t => t.lang === lang && t.abbr !== requestedAbbr)
    .filter(t => (
      ((t.bg && canUseBibleGatewayProxy()) || BIBLEGATEWAY_MAP[t.abbr]) ||
      BIBLE_API_MAP[t.abbr] ||
      HELLOAO_MAP[t.abbr] ||
      (canUseBibleGatewayProxy() && YOUVERSION_MAP[t.abbr]) ||
      APIBIBLE_IDS[t.abbr]
    ))
    .map(t => t.abbr);
}

async function lookupVerse() {
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

  const DEFAULT_FALLBACK_ABBR = 'NASB';
  const requestedAbbr = (transAbbr && transAbbr !== 'NONE') ? transAbbr : '';
  const cacheTransKey = requestedAbbr || DEFAULT_FALLBACK_ABBR;

  // Canonical cache key. Reference-only lookups share a single ASV-sourced cache entry.
  const verseKey = validTokens.map(t =>
    t.type === 'single' ? String(t.v) : `${t.from}-${t.to}`
  ).join(',');
  const cacheKey = `${book}|${chapter}|${verseKey}|${cacheTransKey}`;

  const cached = verseTextCache[cacheKey];
  if (cached) {
    displayVerseText(cached.text, cached.refOnly);
    return;
  }

  // Verse-number prefix: prepend superscript number when multiple verses are shown
  const showVerseNums = countTokenVerses(validTokens) > 1;
  const prefixed = (num, text) => showVerseNums ? `${toSuperNum(num)} ${text}` : text;

  setLookupStatus('Looking up…', 'loading');

  // Provider order = primary + fallbacks.
  // Free sources are preferred first, then premium.
  // If no translation is selected or selected translation fails, default fallback is NASB via BibleGateway.
  const providers = [];
  const seenProviderKeys = new Set();
  function addProvidersForTranslation(abbr, isFallback = false) {
    if (!abbr) return;
    const canBg = canUseBibleGatewayProxy() && !!(BIBLEGATEWAY_MAP[abbr] || TRANSLATIONS.find(t => t.abbr === abbr)?.bg);
    const list = [];
    if (canBg) list.push('biblegateway');
    if (BIBLE_API_MAP[abbr]) list.push('bible-api');
    if (HELLOAO_MAP[abbr]) list.push('helloao');
    if (canUseBibleGatewayProxy() && YOUVERSION_MAP[abbr]) list.push('youversion');
    if (APIBIBLE_IDS[abbr]) list.push('api.bible');
    list.forEach(id => {
      const key = `${id}|${abbr}`;
      if (seenProviderKeys.has(key)) return;
      seenProviderKeys.add(key);
      providers.push({ id, abbr, refOnly: false, fallback: isFallback });
    });
  }

  // Primary providers from selected translation
  addProvidersForTranslation(requestedAbbr, false);

  // Language-level fallbacks: if selected translation fails, try same-language
  // alternatives before defaulting to NASB.
  getLanguageFallbackAbbrs(requestedAbbr).forEach(abbr => addProvidersForTranslation(abbr, true));

  // Default fallback when no translation is set or selected translation has no/failed text
  if (!requestedAbbr || requestedAbbr !== DEFAULT_FALLBACK_ABBR) {
    addProvidersForTranslation(DEFAULT_FALLBACK_ABBR, true);
  }

  // Final reference-only fallback if no source is available at all
  if (providers.length === 0) providers.push({ id: 'reference-asv', abbr: 'ASV', refOnly: true });

  let lastError = null;
  for (const p of providers) {
    try {
      let text = '';
      if (p.id === 'biblegateway') text = await fetchBibleGatewayText(book, chapter, validTokens, p.abbr, prefixed);
      if (p.id === 'bible-api') text = await fetchBibleApiText(book, chapter, validTokens, p.abbr, prefixed, false);
      if (p.id === 'helloao') text = await fetchHelloAoText(book, chapter, validTokens, p.abbr, prefixed);
      if (p.id === 'youversion') text = await fetchYouVersionText(book, chapter, validTokens, p.abbr, prefixed);
      if (p.id === 'api.bible') text = await fetchApiBibleText(book, chapter, validTokens, p.abbr, prefixed);
      if (p.id === 'reference-asv') text = await fetchBibleApiText(book, chapter, validTokens, p.abbr, prefixed, true);
      if (text) {
        const lang = TRANSLATIONS.find(t => t.abbr === p.abbr)?.lang || 'en';
        if (!hasExpectedScript(text, lang)) {
          throw new Error(`${p.abbr} returned unexpected script for ${lang}`);
        }
        finaliseLookup(cacheKey, text, p.refOnly);
        return;
      }
    } catch (err) {
      lastError = err;
    }
  }

  setLookupStatus(`Lookup failed: ${lastError?.message || 'No provider succeeded'}`, 'error');
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
  // Reference-only: disable "use as line 2" — text is for verification, not output.
  // When real verse text exists, auto-enable line2 usage for immediate output.
  if (chk) {
    const translAbbr = document.getElementById('translation')?.value || '';
    if (refOnly || translAbbr === 'NONE') {
      chk.checked = false;
      chk.disabled = true;
    } else {
      chk.disabled = false;
      chk.checked = false;
    }
  }
  if (note) note.style.display = refOnly ? '' : 'none';
  syncBibleLineOptions();
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
  syncBibleLineOptions();
}

// ── Build Ticker Data Object ──────────────────────────────────────────────────
function buildTickerData() {
  const message  = document.getElementById('ticker-message')?.value.trim() || DEFAULT_TICKER_MESSAGE;
  const label    = document.getElementById('ticker-label')?.value.trim()   || 'INFO';
  const speed    = parseInt(document.getElementById('ticker-speed')?.value) || 140;
  const style    = document.getElementById('ticker-style')?.value           || DEFAULT_TICKER_STYLE;
  const position = document.getElementById('ticker-position')?.value        || 'bottom';
  const barHeight = parseInt(document.getElementById('ticker-bar-height')?.value || '68', 10);
  const textSize = parseInt(document.getElementById('ticker-font-size')?.value || '28', 10);
  const badgeSize = parseInt(document.getElementById('ticker-badge-size')?.value || '22', 10);
  const forceTextColor = !!document.getElementById('ticker-force-text-color')?.checked;
  const textColorOverride = document.getElementById('ticker-text-color-override')?.value || '#ffffff';

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

  const textColor = forceTextColor ? textColorOverride : colors.text;
  return {
    message,
    label,
    speed,
    position,
    bgColor: colors.bg,
    textColor,
    barHeight: Math.max(24, Math.min(140, barHeight || 68)),
    textSize: Math.max(12, Math.min(72, textSize || 28)),
    badgeSize: Math.max(10, Math.min(64, badgeSize || 22)),
  };
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
    const refLang    = getReferenceLanguage();
    const translation = TRANSLATIONS.find(t => t.abbr === translAbbr);

    // Compute maxVerse so the ref is sanitised before going to output
    const bookObj  = BIBLE_BOOKS.find(b => b.name === book);
    const chapIdx  = parseInt(chapter, 10) - 1;
    const maxVerse = bookObj && bookObj.verses ? bookObj.verses[chapIdx] : 999;

    const hideEnglishBookName = !!document.getElementById('hide-english-book-name')?.checked;
    let ref = formatReferenceBookName(book, refLang, hideEnglishBookName);
    if (chapter) {
      ref += ' ' + chapter;
      if (verseRaw) {
        const sanitised = formatVerseRef(verseRaw, maxVerse);
        if (sanitised) ref += ':' + sanitised;
      }
    }

    const includeText = document.getElementById('include-verse-text')?.checked;
    const hideTranslationLine2 = !!document.getElementById('hide-translation-line2')?.checked;
    const appendTranslationAbbrLine1 = !!document.getElementById('append-translation-abbr-line1')?.checked;
    const showingText = !!(includeText && verseTextCurrent && !referenceOnlyLookup);

    // Optionally append (ABBR) to the reference line.
    const showTranslationAbbrOnLine1 = translAbbr !== 'NONE'
      && (showingText || (appendTranslationAbbrLine1 && hideTranslationLine2));
    const line1 = showTranslationAbbrOnLine1
      ? `${ref} (${translAbbr})`
      : ref;

    // line2: verse text → translation full name → empty (when NONE selected)
    let line2;
    if (showingText) {
      line2 = verseTextCurrent;
    } else if (hideTranslationLine2) {
      line2 = '';
    } else if (translAbbr === 'NONE') {
      line2 = '';
    } else {
      line2 = translation ? translation.name : translAbbr;
    }

    return { type: 'bible', line1, line2 };
  } else {
    const name  = document.getElementById('speaker-name').value.trim();
    const title = document.getElementById('speaker-title').value.trim();
    return { type: 'speaker', line1: name || '', line2: title || '' };
  }
}

// ── Preview helpers ───────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function substitutePreviewVars(str, s, data) {
  const line1Font = resolvedFontFamily(s.line1Font || s.font);
  const line2Font = resolvedFontFamily(s.line2Font || s.line1Font || s.font);
  return str
    .replace(/\{\{line1\}\}/g,       data?.line1 ? escapeHtml(data.line1) : '')
    .replace(/\{\{line2\}\}/g,       data?.line2 ? escapeHtml(data.line2) : '')
    .replace(/\{\{accentColor\}\}/g, s.accentColor || '#C8A951')
    .replace(/\{\{font\}\}/g,        line1Font)
    .replace(/\{\{line1Font\}\}/g,   line1Font)
    .replace(/\{\{line2Font\}\}/g,   line2Font)
    .replace(/\{\{logoUrl\}\}/g,     s.logoDataUrl  || '')
    .replace(/\{\{bgUrl\}\}/g,       s.ltBgImage    || '');
}

function applyMonitorTextFit(ltEl, viewportEl, style, line2Text) {
  if (!ltEl || !viewportEl) return;
  const vpWidth = viewportEl.offsetWidth || 320;
  const scale = Math.max(0.2, Math.min(1, vpWidth / 1280));
  const len = (line2Text || '').trim().length;

  // Base sizes at output reference width (1920px), then scaled into monitor.
  let baseLine1 = 52;
  let baseLine2 = 34;
  let baseLine2Lh = 1.2;
  if (style === 'scripture') {
    baseLine1 = 30;
    baseLine2 = 24;
    baseLine2Lh = 1.3;
  } else if (style === 'scripture-panel') {
    baseLine1 = 26;
    baseLine2 = 22;
    baseLine2Lh = 1.34;
  }

  // Dense passages get proportionally smaller in monitors to preserve composition.
  let density = 1;
  if (len > 300) density = 0.56;
  else if (len > 220) density = 0.66;
  else if (len > 160) density = 0.78;
  else if (len > 120) density = 0.88;
  else if (len > 0 && len < 36) density = 1.12;

  const line2Px = Math.max(12, Math.round(baseLine2 * scale * density * 10) / 10);
  const line1Px = Math.max(18, Math.round(baseLine1 * scale * Math.max(0.78, density + 0.08) * 10) / 10);
  ltEl.style.setProperty('--monitor-line1-size', `${line1Px}px`);
  ltEl.style.setProperty('--monitor-line2-size', `${line2Px}px`);
  ltEl.style.setProperty('--monitor-line2-lh', String(baseLine2Lh));
}

function applyMonitorTickerStyle(barEl, badgeEl, textEl, viewportEl, td) {
  if (!barEl || !badgeEl || !textEl || !td) return;
  const vpWidth = viewportEl?.offsetWidth || 320;
  const scale = Math.max(0.15, Math.min(1, vpWidth / 1920));
  const barH = Math.max(8, Math.round((td.barHeight || 68) * scale));
  const textSize = Math.max(6, Math.round((td.textSize || 28) * scale * 10) / 10);
  const badgeSize = Math.max(5, Math.round((td.badgeSize || 22) * scale * 10) / 10);
  barEl.style.height = `${barH}px`;
  textEl.style.fontSize = `${textSize}px`;
  badgeEl.style.fontSize = `${badgeSize}px`;
}

function applyLowerThirdVisualSettings(ltEl, ltTextEl, line2El, settings) {
  if (!ltEl || !ltTextEl || !settings) return;
  applyStyleAwareLowerThirdBackground(ltTextEl, settings);

  const widthPct = Math.max(40, Math.min(100, parseInt(settings.ltWidth || 100, 10)));
  ltEl.style.width = `${widthPct}%`;
  ltEl.style.maxWidth = '100%';

  if (line2El) {
    const inlineStyle = isInlineLowerThirdStyle(settings.style || 'gradient');
    const multiline = !!settings.line2Multiline && !inlineStyle;
    const maxLines = Math.max(1, Math.min(6, parseInt(settings.line2MaxLines || 2, 10)));
    const hasLine2 = !!(line2El.textContent || '').trim();

    line2El.style.whiteSpace = multiline ? 'normal' : 'nowrap';
    line2El.style.overflow = 'hidden';
    line2El.style.textOverflow = multiline ? 'clip' : 'ellipsis';
    line2El.style.display = !hasLine2 ? 'none' : (multiline ? '-webkit-box' : 'block');
    line2El.style.webkitBoxOrient = multiline ? 'vertical' : '';
    line2El.style.webkitLineClamp = multiline ? String(maxLines) : '';
    line2El.style.lineClamp = multiline ? String(maxLines) : '';
  }
}

function updateSettingsCompactState() {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;
  const sections = panel.querySelectorAll('.settings-subsection');
  if (!sections.length) {
    panel.classList.remove('compact-collapsed');
    return;
  }
  const anyOpen = Array.from(sections).some((sec) => sec.open);
  panel.classList.toggle('compact-collapsed', !anyOpen);
}

function initSettingsSubsectionState() {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;
  panel.querySelectorAll('.settings-subsection').forEach((sec) => {
    sec.addEventListener('toggle', updateSettingsCompactState);
  });
  updateSettingsCompactState();
}

function switchTextEffectsLine(lineKey) {
  const l1Btn  = document.getElementById('textfx-tab-line1');
  const l2Btn  = document.getElementById('textfx-tab-line2');
  const l1Card = document.getElementById('textfx-card-line1');
  const l2Card = document.getElementById('textfx-card-line2');
  const showLine1 = lineKey !== 'line2';

  if (l1Btn)  l1Btn.classList.toggle('active', showLine1);
  if (l2Btn)  l2Btn.classList.toggle('active', !showLine1);
  if (l1Card) l1Card.style.display = showLine1 ? '' : 'none';
  if (l2Card) l2Card.style.display = showLine1 ? 'none' : '';
}

function updateTextFxSectionState(lineKey, sectionKey) {
  const enabledInput = document.getElementById(`${lineKey}-${sectionKey}-enabled`);
  const sectionEl = document.getElementById(`${lineKey}-${sectionKey}-section`);
  if (!enabledInput || !sectionEl) return;
  const isEnabled = !!enabledInput.checked;
  sectionEl.classList.toggle('disabled', !isEnabled);
}

function onTextFxSectionToggle(lineKey, sectionKey) {
  updateTextFxSectionState(lineKey, sectionKey);
  onSettingsChange();
}

function toggleTextFxSection(lineKey, sectionKey) {
  const sectionBodyEl = document.getElementById(`${lineKey}-${sectionKey}-section`);
  if (!sectionBodyEl) return;
  const sectionCardEl = sectionBodyEl.closest('.textfx-section');
  if (!sectionCardEl) return;
  sectionCardEl.classList.toggle('collapsed');
}

function applyMonitorCustomStageScale(stageEl, viewportEl) {
  if (!stageEl || !viewportEl) return;
  const wrapEl = stageEl.parentElement;
  const vw = viewportEl.clientWidth || 320;
  let padX = 0;
  if (wrapEl) {
    const cs = getComputedStyle(wrapEl);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    padX = pl + pr;
  }
  const availableW = Math.max(1, vw - padX);
  const scale = Math.max(0.1, Math.min(1, availableW / 1920));
  stageEl.style.width = '1920px';
  stageEl.style.transform = `scale(${scale})`;
  if (wrapEl) {
    const layoutHeight = Math.max(1, stageEl.offsetHeight || stageEl.scrollHeight || 1);
    wrapEl.style.height = `${Math.round(layoutHeight * scale)}px`;
  }
}

function scheduleMonitorRenderSync() {
  if (renderSyncRaf) return;
  renderSyncRaf = requestAnimationFrame(() => {
    renderSyncRaf = 0;
    updatePreview();
    updateProgramMonitor();
  });
}

function initMonitorRenderSync() {
  const previewViewport = document.querySelector('.preview-viewport');
  const programViewport = document.querySelector('#monitor-program-block .monitor-viewport');
  const main = document.querySelector('.app-main');
  const panel = document.getElementById('settings-panel');

  window.addEventListener('resize', scheduleMonitorRenderSync);
  window.addEventListener('orientationchange', scheduleMonitorRenderSync);

  if (typeof ResizeObserver === 'function') {
    monitorResizeObserver = new ResizeObserver(() => scheduleMonitorRenderSync());
    if (previewViewport) monitorResizeObserver.observe(previewViewport);
    if (programViewport) monitorResizeObserver.observe(programViewport);
    if (main) monitorResizeObserver.observe(main);
    if (panel) monitorResizeObserver.observe(panel);
  }
}

// ── Preview ───────────────────────────────────────────────────────────────────
function updatePreview() {
  updateCutToAirButtonState();
  if (currentMode === 'bible') syncBibleLineOptions();
  const data     = buildOverlayData();
  const settings = getSettings();
  const useCustom = !!(settings.customTemplate?.enabled && settings.customTemplate?.html);

  const previewWrap   = document.getElementById('preview-wrap');
  const customWrap    = document.getElementById('preview-custom-wrap');
  const customStage   = document.getElementById('preview-custom-stage');
  const customEl      = document.getElementById('preview-custom');
  const tickerPreview = document.getElementById('preview-ticker-wrap');
  const previewViewport = document.querySelector('.preview-viewport');

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
    applyMonitorTickerStyle(bar, badge, text, previewViewport, td);
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
    if (customWrap) {
      customWrap.classList.remove('pos-lower', 'pos-upper', 'pos-center');
      customWrap.classList.add('pos-' + (settings.position || 'lower'));
    }
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
    applyMonitorCustomStageScale(customStage, previewViewport);
    return;
  }

  // ── Standard lower-third preview ─────────────────────────────────────────
  if (previewWrap) previewWrap.style.display = '';
  if (customWrap)  customWrap.style.display  = 'none';
  if (previewWrap) {
    previewWrap.classList.remove('pos-lower', 'pos-upper', 'pos-center');
    previewWrap.classList.add('pos-' + (settings.position || 'lower'));
  }
  // Clear injected custom CSS when template is disabled
  const staleStyle = document.getElementById('preview-custom-style');
  if (staleStyle) staleStyle.textContent = '';

  document.getElementById('preview-line1').textContent   = data.line1;
  document.getElementById('preview-line2').textContent   = data.line2;
  document.getElementById('preview-line2').style.display = data.line2 ? '' : 'none';

  const lt = document.getElementById('preview-lower-third');
  lt.className = 'lower-third';
  lt.classList.add('style-' + settings.style);
  applyMonitorTextFit(lt, previewViewport, settings.style, data.line2 || '');

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
    ltText.style.fontFamily = resolvedFontFamily(settings.line1Font || settings.font);
    ltText.style.textAlign  = settings.textAlign || 'left';
  }
  const previewLine1 = document.getElementById('preview-line1');
  const previewLine2 = document.getElementById('preview-line2');
  if (previewLine1) previewLine1.style.fontFamily = resolvedFontFamily(settings.line1Font || settings.font);
  if (previewLine2) previewLine2.style.fontFamily = resolvedFontFamily(settings.line2Font || settings.line1Font || settings.font);
  applyLineTextEffects(
    previewLine1,
    previewLine2,
    settings
  );
  applyLowerThirdVisualSettings(lt, ltText, previewLine2, settings);
}

// ── Presets ───────────────────────────────────────────────────────────────────
// Preset storage uses global keys (no session ID) so presets are shared across
// all sessions on the same browser. Use Export / Import to move between devices.
const PRESET_KEY_OVERLAY = 'overlayPresets';
const PRESET_KEY_TICKER  = 'tickerPresets';
const PRESET_KEY_TEMPLATE = 'templatePresets';
const SETTINGS_PROFILE_KEY = 'overlaySettingsProfiles';

function loadPresets() {
  try {
    overlayPresets = JSON.parse(localStorage.getItem(PRESET_KEY_OVERLAY) || '[]');
  } catch (_) { overlayPresets = []; }
  try {
    tickerPresets  = JSON.parse(localStorage.getItem(PRESET_KEY_TICKER)  || '[]');
  } catch (_) { tickerPresets  = []; }
  try {
    templatePresets = JSON.parse(localStorage.getItem(PRESET_KEY_TEMPLATE) || '[]');
  } catch (_) { templatePresets = []; }
  renderPresets();
  renderTemplatePresets();
}

function loadSettingsProfiles() {
  try {
    settingsProfiles = JSON.parse(localStorage.getItem(SETTINGS_PROFILE_KEY) || '[]');
  } catch (_) {
    settingsProfiles = [];
  }
  renderSettingsProfiles();
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
          translation: document.getElementById('translation').value,
          refLanguage: document.getElementById('reference-language')?.value || 'en',
          hideLine2:   !!document.getElementById('hide-translation-line2')?.checked,
          appendAbbrLine1: !!document.getElementById('append-translation-abbr-line1')?.checked,
          hideEnglishBookName: !!document.getElementById('hide-english-book-name')?.checked }
      : currentMode === 'speaker'
      ? { name:  document.getElementById('speaker-name').value,
          title: document.getElementById('speaker-title').value }
      : { message:  document.getElementById('ticker-message')?.value || '',
          label:    document.getElementById('ticker-label')?.value   || 'INFO',
          speed:    document.getElementById('ticker-speed')?.value   || '140',
          style:    document.getElementById('ticker-style')?.value   || DEFAULT_TICKER_STYLE,
          position: document.getElementById('ticker-position')?.value || 'bottom',
          barHeight: document.getElementById('ticker-bar-height')?.value || '68',
          textSize: document.getElementById('ticker-font-size')?.value || '28',
          badgeSize: document.getElementById('ticker-badge-size')?.value || '22',
          forceTextColor: !!document.getElementById('ticker-force-text-color')?.checked,
          textColorOverride: document.getElementById('ticker-text-color-override')?.value || '#ffffff' },
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
      const refLangEl = document.getElementById('reference-language');
      if (refLangEl) refLangEl.value = p.data.refLanguage || 'en';
      const hideLine2El = document.getElementById('hide-translation-line2');
      if (hideLine2El) hideLine2El.checked = !!p.data.hideLine2;
      const appendAbbrEl = document.getElementById('append-translation-abbr-line1');
      if (appendAbbrEl) appendAbbrEl.checked = !!p.data.appendAbbrLine1;
      const hideEnglishEl = document.getElementById('hide-english-book-name');
      if (hideEnglishEl) hideEnglishEl.checked = !!p.data.hideEnglishBookName;
      syncBookNameDisplayOption();
      updateBookOptionLabels();
      if (refLangEl && refLangEl.value !== 'en') maybeApplyLanguageFont(refLangEl.value, false);
      validateVerseInput();
    } else {
      document.getElementById('speaker-name').value  = p.data.name;
      document.getElementById('speaker-title').value = p.data.title;
    }
  } else {
    if (document.getElementById('ticker-message'))
      document.getElementById('ticker-message').value  = p.data.message  || '';
    if (document.getElementById('ticker-label'))
      document.getElementById('ticker-label').value    = p.data.label    || 'INFO';
    if (document.getElementById('ticker-speed'))
      document.getElementById('ticker-speed').value    = p.data.speed    || '140';
    if (document.getElementById('ticker-style')) {
      document.getElementById('ticker-style').value    = p.data.style    || DEFAULT_TICKER_STYLE;
      onTickerStyleChange();
    }
    if (document.getElementById('ticker-position'))
      document.getElementById('ticker-position').value = p.data.position || 'bottom';
    if (document.getElementById('ticker-bar-height'))
      document.getElementById('ticker-bar-height').value = p.data.barHeight || '68';
    if (document.getElementById('ticker-font-size'))
      document.getElementById('ticker-font-size').value = p.data.textSize || '28';
    if (document.getElementById('ticker-badge-size'))
      document.getElementById('ticker-badge-size').value = p.data.badgeSize || '22';
    if (document.getElementById('ticker-force-text-color'))
      document.getElementById('ticker-force-text-color').checked = !!p.data.forceTextColor;
    if (document.getElementById('ticker-text-color-override'))
      document.getElementById('ticker-text-color-override').value = p.data.textColorOverride || '#ffffff';
    onTickerSizeInput();
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
  try { localStorage.setItem(PRESET_KEY_TEMPLATE, JSON.stringify(templatePresets)); } catch (_) {}
}

// ── Preset Export / Import ─────────────────────────────────────────────────────
function exportPresets() {
  const payload = JSON.stringify({ overlayPresets, tickerPresets, templatePresets }, null, 2);
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
        if (Array.isArray(data.templatePresets)) mergeIn(templatePresets, data.templatePresets);
        savePresetsToStorage();
        renderPresets();
        renderTemplatePresets();
        const countO = Array.isArray(data.overlayPresets) ? data.overlayPresets.length : 0;
        const countT = Array.isArray(data.tickerPresets)  ? data.tickerPresets.length  : 0;
        const countTpl = Array.isArray(data.templatePresets) ? data.templatePresets.length : 0;
        alert(`Imported ${countO} overlay preset(s), ${countT} ticker preset(s), and ${countTpl} template preset(s).`);
      } catch (_) {
        alert('Import failed — file does not appear to be a valid presets export.');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ── Settings Profiles (global, reusable across sessions) ─────────────────────
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildSessionControlState() {
  return {
    mode: currentMode,
    bible: {
      book: document.getElementById('book')?.value || 'John',
      chapter: document.getElementById('chapter')?.value || '3',
      verseRef: document.getElementById('verse-ref')?.value || '16-18',
      translation: document.getElementById('translation')?.value || 'NONE',
      referenceLanguage: document.getElementById('reference-language')?.value || 'en',
      hideTranslationLine2: !!document.getElementById('hide-translation-line2')?.checked,
      includeVerseText: !!document.getElementById('include-verse-text')?.checked,
      appendTranslationAbbrLine1: !!document.getElementById('append-translation-abbr-line1')?.checked,
      hideEnglishBookName: !!document.getElementById('hide-english-book-name')?.checked,
    },
    speaker: {
      name: document.getElementById('speaker-name')?.value || '',
      title: document.getElementById('speaker-title')?.value || '',
    },
    ticker: {
      message: document.getElementById('ticker-message')?.value || DEFAULT_TICKER_MESSAGE,
      label: document.getElementById('ticker-label')?.value || 'INFO',
      speed: document.getElementById('ticker-speed')?.value || '140',
      style: document.getElementById('ticker-style')?.value || DEFAULT_TICKER_STYLE,
      position: document.getElementById('ticker-position')?.value || 'bottom',
      bgColor: document.getElementById('ticker-bg-color')?.value || '#cc0000',
      textColor: document.getElementById('ticker-text-color')?.value || '#ffffff',
      barHeight: document.getElementById('ticker-bar-height')?.value || '68',
      textSize: document.getElementById('ticker-font-size')?.value || '28',
      badgeSize: document.getElementById('ticker-badge-size')?.value || '22',
      forceTextColor: !!document.getElementById('ticker-force-text-color')?.checked,
      textColorOverride: document.getElementById('ticker-text-color-override')?.value || '#ffffff',
    },
  };
}

function buildSettingsProfilePayload() {
  return {
    settings: getSettings(),
    overlayModeSettings: cloneJson(overlayModeSettings),
    controlState: buildSessionControlState(),
    overlayPresets: cloneJson(overlayPresets),
    tickerPresets: cloneJson(tickerPresets),
    templatePresets: cloneJson(templatePresets),
    exportedAt: Date.now(),
  };
}

function saveSettingsProfilesToStorage() {
  try {
    localStorage.setItem(SETTINGS_PROFILE_KEY, JSON.stringify(settingsProfiles));
  } catch (_) {}
}

function renderSettingsProfiles() {
  const sel = document.getElementById('settings-profile-select');
  if (!sel) return;
  const previous = sel.value;
  sel.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = settingsProfiles.length ? 'Select a profile...' : 'No settings profiles yet';
  sel.appendChild(empty);
  settingsProfiles.forEach(profile => {
    const opt = document.createElement('option');
    opt.value = profile.id;
    opt.textContent = profile.label || 'Unnamed profile';
    sel.appendChild(opt);
  });
  if (previous && settingsProfiles.some(p => p.id === previous)) {
    sel.value = previous;
  } else {
    sel.value = '';
  }
}

function saveSettingsProfile() {
  const defaultName = `Session Profile ${new Date().toLocaleString()}`;
  const label = prompt('Settings profile name:', defaultName);
  if (label === null || !label.trim()) return;

  const payload = buildSettingsProfilePayload();
  const existing = settingsProfiles.find(p => p.label.toLowerCase() === label.trim().toLowerCase());
  let savedId = '';
  if (existing) {
    existing.payload = payload;
    existing.updatedAt = Date.now();
    savedId = existing.id;
  } else {
    const newProfile = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label: label.trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      payload,
    };
    settingsProfiles.push(newProfile);
    savedId = newProfile.id;
  }
  settingsProfiles.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  saveSettingsProfilesToStorage();
  renderSettingsProfiles();
  const sel = document.getElementById('settings-profile-select');
  if (sel && savedId) sel.value = savedId;
}

function applyProfileSettingsToSession(profileSettings) {
  if (!profileSettings || typeof profileSettings !== 'object') return;
  try {
    const small = { ...profileSettings, ltBgImage: null, logoDataUrl: null };
    localStorage.setItem('overlaySettings-' + SESSION_ID, JSON.stringify(small));

    if (profileSettings.ltBgImage) localStorage.setItem('overlayLtBg-' + SESSION_ID, profileSettings.ltBgImage);
    else localStorage.removeItem('overlayLtBg-' + SESSION_ID);

    if (profileSettings.logoDataUrl) localStorage.setItem('overlayLogo-' + SESSION_ID, profileSettings.logoDataUrl);
    else localStorage.removeItem('overlayLogo-' + SESSION_ID);

    if (profileSettings.customTemplate) {
      localStorage.setItem(GLOBAL_TEMPLATE_KEY, JSON.stringify(profileSettings.customTemplate));
    }
  } catch (_) {}
}

function applyProfileControlState(controlState) {
  if (!controlState || typeof controlState !== 'object') return;

  const bible = controlState.bible || {};
  const speaker = controlState.speaker || {};
  const ticker = controlState.ticker || {};

  const bookEl = document.getElementById('book');
  const chapterEl = document.getElementById('chapter');
  const verseEl = document.getElementById('verse-ref');
  const transEl = document.getElementById('translation');
  const refLangEl = document.getElementById('reference-language');
  const hideLine2El = document.getElementById('hide-translation-line2');
  const includeVerseTextEl = document.getElementById('include-verse-text');
  const appendAbbrLine1El = document.getElementById('append-translation-abbr-line1');
  const hideEnglishBookNameEl = document.getElementById('hide-english-book-name');

  if (bookEl && bible.book) {
    bookEl.value = bible.book;
    populateChapters(bible.book, parseInt(bible.chapter || '1', 10));
  }
  if (chapterEl && bible.chapter) chapterEl.value = String(bible.chapter);
  if (verseEl && bible.verseRef !== undefined) verseEl.value = String(bible.verseRef || '');
  if (transEl && bible.translation) transEl.value = bible.translation;
  if (refLangEl) refLangEl.value = bible.referenceLanguage || 'en';
  if (hideLine2El) hideLine2El.checked = !!bible.hideTranslationLine2;
  if (includeVerseTextEl) includeVerseTextEl.checked = !!bible.includeVerseText;
  if (appendAbbrLine1El) appendAbbrLine1El.checked = !!bible.appendTranslationAbbrLine1;
  if (hideEnglishBookNameEl) hideEnglishBookNameEl.checked = !!bible.hideEnglishBookName;
  syncBookNameDisplayOption();
  updateBookOptionLabels();
  validateVerseInput();

  const speakerNameEl = document.getElementById('speaker-name');
  const speakerTitleEl = document.getElementById('speaker-title');
  if (speakerNameEl) speakerNameEl.value = speaker.name || '';
  if (speakerTitleEl) speakerTitleEl.value = speaker.title || '';

  const tickerMessageEl = document.getElementById('ticker-message');
  const tickerLabelEl = document.getElementById('ticker-label');
  const tickerSpeedEl = document.getElementById('ticker-speed');
  const tickerStyleEl = document.getElementById('ticker-style');
  const tickerPositionEl = document.getElementById('ticker-position');
  const tickerBgEl = document.getElementById('ticker-bg-color');
  const tickerTextEl = document.getElementById('ticker-text-color');
  const tickerBarHeightEl = document.getElementById('ticker-bar-height');
  const tickerFontSizeEl = document.getElementById('ticker-font-size');
  const tickerBadgeSizeEl = document.getElementById('ticker-badge-size');
  const tickerForceTextEl = document.getElementById('ticker-force-text-color');
  const tickerTextOverrideEl = document.getElementById('ticker-text-color-override');
  if (tickerMessageEl) tickerMessageEl.value = ticker.message || DEFAULT_TICKER_MESSAGE;
  if (tickerLabelEl) tickerLabelEl.value = ticker.label || 'INFO';
  if (tickerSpeedEl) tickerSpeedEl.value = ticker.speed || '140';
  if (tickerStyleEl) tickerStyleEl.value = ticker.style || DEFAULT_TICKER_STYLE;
  if (tickerPositionEl) tickerPositionEl.value = ticker.position || 'bottom';
  if (tickerBgEl) tickerBgEl.value = ticker.bgColor || '#cc0000';
  if (tickerTextEl) tickerTextEl.value = ticker.textColor || '#ffffff';
  if (tickerBarHeightEl) tickerBarHeightEl.value = ticker.barHeight || '68';
  if (tickerFontSizeEl) tickerFontSizeEl.value = ticker.textSize || '28';
  if (tickerBadgeSizeEl) tickerBadgeSizeEl.value = ticker.badgeSize || '22';
  if (tickerForceTextEl) tickerForceTextEl.checked = !!ticker.forceTextColor;
  if (tickerTextOverrideEl) tickerTextOverrideEl.value = ticker.textColorOverride || '#ffffff';
  onTickerSizeInput();
  onTickerStyleChange();

  setMode(controlState.mode || 'bible');
}

function loadSelectedSettingsProfile() {
  const sel = document.getElementById('settings-profile-select');
  if (!sel || !sel.value) return;
  const profile = settingsProfiles.find(p => p.id === sel.value);
  if (!profile || !profile.payload) return;

  const payload = profile.payload;
  if (payload.overlayModeSettings && typeof payload.overlayModeSettings === 'object') {
    overlayModeSettings = {
      bible: payload.overlayModeSettings.bible ? cloneJson(payload.overlayModeSettings.bible) : cloneJson(defaultOverlayModeSettings),
      speaker: payload.overlayModeSettings.speaker ? cloneJson(payload.overlayModeSettings.speaker) : cloneJson(defaultOverlayModeSettings),
    };
    try {
      localStorage.setItem(OVERLAY_MODE_SETTINGS_KEY_PREFIX + SESSION_ID, JSON.stringify(overlayModeSettings));
    } catch (_) {}
  }
  overlayPresets = Array.isArray(payload.overlayPresets) ? cloneJson(payload.overlayPresets) : [];
  tickerPresets = Array.isArray(payload.tickerPresets) ? cloneJson(payload.tickerPresets) : [];
  templatePresets = Array.isArray(payload.templatePresets) ? cloneJson(payload.templatePresets) : [];
  savePresetsToStorage();
  renderPresets();
  renderTemplatePresets();

  applyProfileSettingsToSession(payload.settings || {});
  loadSettings();
  applyProfileControlState(payload.controlState || {});
  updatePreview();
}

function deleteSelectedSettingsProfile() {
  const sel = document.getElementById('settings-profile-select');
  if (!sel || !sel.value) return;
  settingsProfiles = settingsProfiles.filter(p => p.id !== sel.value);
  saveSettingsProfilesToStorage();
  renderSettingsProfiles();
}

function exportSettingsProfiles() {
  const payload = JSON.stringify({ settingsProfiles }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'overlay-settings-profiles.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importSettingsProfiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result);
        let incoming = [];
        if (Array.isArray(parsed?.settingsProfiles)) incoming = parsed.settingsProfiles;
        else if (parsed?.payload) incoming = [parsed];
        if (!incoming.length) throw new Error('No profiles');

        const byId = new Map(settingsProfiles.map(p => [p.id, p]));
        incoming.forEach(profile => {
          if (!profile || !profile.id || !profile.payload) return;
          byId.set(profile.id, profile);
        });
        settingsProfiles = Array.from(byId.values())
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        saveSettingsProfilesToStorage();
        renderSettingsProfiles();
      } catch (_) {
        alert('Import failed — file does not appear to be a valid settings profile export.');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function renderPresets() {
  const isTicker  = currentMode === 'ticker';
  const isSpeaker = currentMode === 'speaker';
  const isBible   = currentMode === 'bible';

  // Update section label
  const labelEl = document.getElementById('presets-label');
  if (labelEl) {
    labelEl.textContent = isTicker
      ? 'Ticker Presets'
      : isSpeaker
      ? 'Speaker Presets'
      : 'Reference Presets';
  }

  // Show / hide the correct list
  const overlayList = document.getElementById('presets-list-overlay');
  const tickerList  = document.getElementById('presets-list-ticker');
  if (overlayList) overlayList.style.display = isTicker ? 'none' : '';
  if (tickerList)  tickerList.style.display  = isTicker ? ''     : 'none';

  const list  = isTicker ? tickerList  : overlayList;
  const empty = document.getElementById(isTicker ? 'presets-empty-ticker' : 'presets-empty-overlay');
  const store = isTicker
    ? tickerPresets
    : overlayPresets.filter(p => isBible ? p.mode === 'bible' : p.mode === 'speaker');
  if (!list) return;

  list.querySelectorAll('.preset-chip').forEach(el => el.remove());

  if (store.length === 0) {
    if (empty && !isTicker) {
      empty.textContent = isBible
        ? 'No reference presets saved — click Save Current to add one'
        : 'No speaker presets saved — click Save Current to add one';
    }
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
      const langTag = p.data.refLanguage ? `, ${p.data.refLanguage}` : '';
      loadBtn.title = `${p.data.book} ${p.data.chapter}:${p.data.verse} (${p.data.translation}${langTag})`;
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
    // Commit any in-progress control edit (range/select/color pickers) before reading values.
    const active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();

    requestAnimationFrame(() => {
      const td = buildTickerData();
      if (!td.message) return;
      broadcast({ action: 'show-ticker', data: td });
      programTickerData = td;
      programTickerLive = true;
      setTickerStatus(true);
      updateProgramMonitor();
    });
    return;
  }

  if (currentMode === 'speaker') {
    const speakerNameEl = document.getElementById('speaker-name');
    const speakerName = speakerNameEl?.value.trim() || '';
    if (!speakerName) {
      if (speakerNameEl) {
        speakerNameEl.setCustomValidity('Speaker name is required before Cut to Air.');
        speakerNameEl.reportValidity();
        speakerNameEl.focus();
      }
      return;
    }
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
  const pgmCustomWrap  = document.getElementById('program-custom-wrap');
  const pgmCustomStage = document.getElementById('program-custom-stage');
  const pgmCustom      = document.getElementById('program-custom');
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
  const pgmViewport    = document.querySelector('#monitor-program-block .monitor-viewport');

  const anythingLive = programOverlayLive || programTickerLive;
  if (offAir) offAir.style.display = anythingLive ? 'none' : '';

  // ── Overlay (lower-third or speaker) ───────────────────────────────────────
  if (programOverlayLive && programOverlayData) {
    const s = programOverlaySettings;
    const useCustom = !!(s && s.customTemplate && s.customTemplate.enabled && s.customTemplate.html);
    if (useCustom) {
      if (pgmWrap) pgmWrap.style.display = 'none';
      if (pgmCustomWrap) {
        pgmCustomWrap.style.display = '';
        pgmCustomWrap.classList.remove('pos-lower', 'pos-upper', 'pos-center');
        pgmCustomWrap.classList.add('pos-' + (s.position || 'lower'));
      }
      if (pgmCustom) {
        pgmCustom.innerHTML = substitutePreviewVars(s.customTemplate.html, s, programOverlayData);
      }
      let styleEl = document.getElementById('program-custom-style');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'program-custom-style';
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = substitutePreviewVars(s.customTemplate.css || '', s, programOverlayData);
      applyMonitorCustomStageScale(pgmCustomStage, pgmViewport);
    } else {
      if (pgmCustomWrap) pgmCustomWrap.style.display = 'none';
      const staleProgramStyle = document.getElementById('program-custom-style');
      if (staleProgramStyle) staleProgramStyle.textContent = '';

      if (pgmWrap) {
        pgmWrap.style.display = '';
        pgmWrap.classList.remove('pos-lower', 'pos-upper', 'pos-center');
        pgmWrap.classList.add('pos-' + (s?.position || 'lower'));
      }

      if (pgmLine1) pgmLine1.textContent = programOverlayData.line1 || '';
      if (pgmLine2) {
        pgmLine2.textContent   = programOverlayData.line2 || '';
        pgmLine2.style.display = programOverlayData.line2 ? '' : 'none';
      }

      if (pgmLt)     pgmLt.className            = 'lower-third style-' + (s?.style || 'gradient');
      applyMonitorTextFit(pgmLt, pgmViewport, s?.style || 'gradient', programOverlayData.line2 || '');
      if (pgmAccent) pgmAccent.style.background  = s?.accentColor || '#C8A951';
      if (pgmLtText) {
        pgmLtText.style.fontFamily = resolvedFontFamily(s?.line1Font || s?.font);
        pgmLtText.style.textAlign  = s?.textAlign || 'left';
      }
      if (pgmLine1) pgmLine1.style.fontFamily = resolvedFontFamily(s?.line1Font || s?.font);
      if (pgmLine2) pgmLine2.style.fontFamily = resolvedFontFamily(s?.line2Font || s?.line1Font || s?.font);
      applyLineTextEffects(pgmLine1, pgmLine2, s || {});
      applyLowerThirdVisualSettings(pgmLt, pgmLtText, pgmLine2, s || {});
      if (pgmLogo) {
        if (s?.logoDataUrl) { pgmLogo.src = s.logoDataUrl; pgmLogo.classList.remove('hidden'); }
        else                               pgmLogo.classList.add('hidden');
      }
    }
  } else {
    if (pgmWrap) pgmWrap.style.display = 'none';
    if (pgmCustomWrap) pgmCustomWrap.style.display = 'none';
  }

  // ── Ticker ─────────────────────────────────────────────────────────────────
  if (programTickerLive && programTickerData) {
    if (pgmTickerWrap) pgmTickerWrap.style.display = '';
    const td = programTickerData;
    if (pgmTickerBar) {
      pgmTickerBar.style.background = td.bgColor   || '#cc0000';
      pgmTickerBar.style.color      = td.textColor || '#ffffff';
    }
    if (pgmTickerBadge) pgmTickerBadge.textContent = td.label   || 'INFO';
    if (pgmTickerText)  pgmTickerText.textContent  = td.message || '';
    applyMonitorTickerStyle(pgmTickerBar, pgmTickerBadge, pgmTickerText, pgmViewport, td);
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

function initSettingsPanelUi() {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;

  // Default load state: collapsed/hidden (desktop + mobile).
  panel.open = false;

  const sync = () => {
    setSettingsPanelState(panel.open);
    scheduleMonitorRenderSync();
  };
  panel.addEventListener('toggle', sync);
  window.addEventListener('resize', sync);
  sync();
}

function setSettingsPanelState(isOpen) {
  const desktop = window.matchMedia('(min-width: 1101px)').matches;
  const main = document.querySelector('.app-main');
  const btn = document.getElementById('btn-settings-toggle');
  if (main) main.classList.toggle('settings-open', !!isOpen && desktop);
  if (btn) {
    btn.classList.toggle('active', !!isOpen);
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    const label = btn.querySelector('.btn-settings-label');
    if (label) label.textContent = isOpen ? 'Hide Settings' : 'Settings';
  }
  scheduleMonitorRenderSync();
}

function toggleSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;
  panel.open = !panel.open;
  setSettingsPanelState(panel.open);
}

function openUserGuide() {
  const modal = document.getElementById('user-guide-modal');
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeUserGuide() {
  const modal = document.getElementById('user-guide-modal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function isUserGuideOpen() {
  const modal = document.getElementById('user-guide-modal');
  return !!(modal && modal.classList.contains('open'));
}

function setOutputSetupTab(tab) {
  const browserBtn = document.getElementById('output-tab-browser');
  const atemBtn = document.getElementById('output-tab-atem');
  const browserPanel = document.getElementById('output-panel-browser');
  const atemPanel = document.getElementById('output-panel-atem');
  const showBrowser = tab !== 'atem';

  if (browserBtn) {
    browserBtn.classList.toggle('is-active', showBrowser);
    browserBtn.setAttribute('aria-selected', showBrowser ? 'true' : 'false');
  }
  if (atemBtn) {
    atemBtn.classList.toggle('is-active', !showBrowser);
    atemBtn.setAttribute('aria-selected', !showBrowser ? 'true' : 'false');
  }
  if (browserPanel) {
    browserPanel.classList.toggle('is-active', showBrowser);
    browserPanel.hidden = !showBrowser;
  }
  if (atemPanel) {
    atemPanel.classList.toggle('is-active', !showBrowser);
    atemPanel.hidden = showBrowser;
  }
}

// ── Copy Output Link ──────────────────────────────────────────────────────────
// Copies the output.html URL (with session ID and current origin/path) so the
// operator can paste it into a TV browser or another device on the same network.


function getAtemExportImageUrl(sessionId = SESSION_ID, alphaMode = 'premultiplied') {
  const mode = String(alphaMode || '').trim().toLowerCase();
  const url = new URL(location.origin + '/atem-live/' + encodeURIComponent(sessionId) + '.png');
  if (mode === 'straight' || mode === 'premultiplied') {
    url.searchParams.set('alpha', mode);
  }
  return url.toString();
}

function updateAtemExportUiState(isPinned) {
  const pinEl = document.getElementById('atem-pin-session');
  const stateEl = document.getElementById('atem-pin-state');
  const premultUrlEl = document.getElementById('atem-export-url');
  const straightUrlEl = document.getElementById('atem-export-url-straight');

  if (pinEl) pinEl.checked = !!isPinned;
  if (premultUrlEl) premultUrlEl.textContent = getAtemExportImageUrl(SESSION_ID, 'premultiplied');
  if (straightUrlEl) straightUrlEl.textContent = getAtemExportImageUrl(SESSION_ID, 'straight');
  if (stateEl) {
    if (isPinned) {
      stateEl.textContent = 'Included in export';
      stateEl.style.color = 'var(--accent)';
    } else {
      stateEl.textContent = 'Not included';
      stateEl.style.color = 'var(--text-muted)';
    }
  }
}

function requestAtemExportStatus() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ action: 'atem-export-status', sessionId: SESSION_ID }));
    } catch (_) {}
  }
}

function syncAtemExportPinConfig() {
  const pinEl = document.getElementById('atem-pin-session');
  const shouldPin = !!pinEl?.checked;
  try { localStorage.setItem(ATEM_EXPORT_PIN_KEY, shouldPin ? '1' : '0'); } catch (_) {}
  updateAtemExportUiState(shouldPin);

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        action: 'atem-export-config',
        pinCurrentSession: shouldPin,
        sessionId: SESSION_ID,
      }));
    } catch (_) {}
  }
}

function onAtemExportPinToggle() {
  syncAtemExportPinConfig();
}

function copyAtemExportLink() {
  // Backward compatibility for existing bindings.
  copyAtemPremultipliedLink();
}

function copyAtemPremultipliedLink() {
  const url = getAtemExportImageUrl(SESSION_ID, 'premultiplied');
  navigator.clipboard.writeText(url).catch(() => prompt('Copy this ATEM premultiplied export URL:', url));
}

function copyAtemStraightLink() {
  const url = getAtemExportImageUrl(SESSION_ID, 'straight');
  navigator.clipboard.writeText(url).catch(() => prompt('Copy this straight alpha preview URL:', url));
}

function onAtemExportRegenerate() {
  const btn = document.getElementById('atem-refresh-btn');
  const setBusy = (busy, label) => {
    if (!btn) return;
    btn.classList.toggle('is-working', !!busy);
    btn.textContent = label;
  };

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ action: 'atem-export-refresh', sessionId: SESSION_ID }));
      setBusy(true, 'Queued');
      setTimeout(() => setBusy(false, 'Regenerate'), 1400);
      return;
    } catch (_) {}
  }

  setBusy(true, 'No WS');
  setTimeout(() => setBusy(false, 'Regenerate'), 1400);
}


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
        // Rehydrate with the actual on-air overlay snapshot, not current edit-mode placeholder data.
        const liveOverlayData = programOverlayData || buildOverlayData();
        setTimeout(() => broadcast({ action: 'show', data: liveOverlayData, settings: s }), 200);
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

  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = new URL(`${wsProto}//${location.host}`);
  wsUrl.searchParams.set('session', SESSION_ID);
  wsUrl.searchParams.set('role', 'control');
  const url = wsUrl.toString();
  try {
    ws = new WebSocket(url);
    ws.onopen    = () => {
      wsRetryDelay = 5000;
      setWsIndicator('online');
      syncCurrentStateToOutputs();
      syncAtemExportPinConfig();
      requestAtemExportStatus();
    };
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
  if (msg.action === 'atem-export-config-ack') {
    const sessions = Array.isArray(msg.pinnedSessions) ? msg.pinnedSessions : [];
    updateAtemExportUiState(sessions.includes(SESSION_ID));
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
  const line1Font = document.getElementById('line1-font-select')?.value || "'Cinzel', serif";
  const line2Font = document.getElementById('line2-font-select')?.value || line1Font;
  const line1Fx = {
    fontWeight:   parseInt(document.getElementById('line1-font-weight')?.value || String(DEFAULT_TEXT_EFFECTS.line1.fontWeight), 10),
    italic:       !!document.getElementById('line1-italic')?.checked,
    fontScale:    parseFloat(document.getElementById('line1-font-scale')?.value || String(DEFAULT_TEXT_EFFECTS.line1.fontScale)),
    useCustomColor: !!document.getElementById('line1-custom-color')?.checked,
    fontColor:    document.getElementById('line1-font-color')?.value || DEFAULT_TEXT_EFFECTS.line1.fontColor,
    shadowEnabled: !!document.getElementById('line1-shadow-enabled')?.checked,
    shadowColor:  document.getElementById('line1-shadow-color')?.value || DEFAULT_TEXT_EFFECTS.line1.shadowColor,
    shadowAngle:  parseFloat(document.getElementById('line1-shadow-angle')?.value || String(DEFAULT_TEXT_EFFECTS.line1.shadowAngle)),
    shadowDepth:  parseFloat(document.getElementById('line1-shadow-depth')?.value || String(DEFAULT_TEXT_EFFECTS.line1.shadowDepth)),
    shadowBlur:   parseFloat(document.getElementById('line1-shadow-blur')?.value || String(DEFAULT_TEXT_EFFECTS.line1.shadowBlur)),
    shadowOpacity:parseFloat(document.getElementById('line1-shadow-opacity')?.value || String(DEFAULT_TEXT_EFFECTS.line1.shadowOpacity)),
    strokeEnabled: !!document.getElementById('line1-stroke-enabled')?.checked,
    strokeColor:  document.getElementById('line1-stroke-color')?.value || DEFAULT_TEXT_EFFECTS.line1.strokeColor,
    strokeWidth:  parseFloat(document.getElementById('line1-stroke-width')?.value || String(DEFAULT_TEXT_EFFECTS.line1.strokeWidth)),
  };
  const line2Fx = {
    fontWeight:   parseInt(document.getElementById('line2-font-weight')?.value || String(DEFAULT_TEXT_EFFECTS.line2.fontWeight), 10),
    italic:       !!document.getElementById('line2-italic')?.checked,
    fontScale:    parseFloat(document.getElementById('line2-font-scale')?.value || String(DEFAULT_TEXT_EFFECTS.line2.fontScale)),
    useCustomColor: !!document.getElementById('line2-custom-color')?.checked,
    fontColor:    document.getElementById('line2-font-color')?.value || DEFAULT_TEXT_EFFECTS.line2.fontColor,
    shadowEnabled: !!document.getElementById('line2-shadow-enabled')?.checked,
    shadowColor:  document.getElementById('line2-shadow-color')?.value || DEFAULT_TEXT_EFFECTS.line2.shadowColor,
    shadowAngle:  parseFloat(document.getElementById('line2-shadow-angle')?.value || String(DEFAULT_TEXT_EFFECTS.line2.shadowAngle)),
    shadowDepth:  parseFloat(document.getElementById('line2-shadow-depth')?.value || String(DEFAULT_TEXT_EFFECTS.line2.shadowDepth)),
    shadowBlur:   parseFloat(document.getElementById('line2-shadow-blur')?.value || String(DEFAULT_TEXT_EFFECTS.line2.shadowBlur)),
    shadowOpacity:parseFloat(document.getElementById('line2-shadow-opacity')?.value || String(DEFAULT_TEXT_EFFECTS.line2.shadowOpacity)),
    strokeEnabled: !!document.getElementById('line2-stroke-enabled')?.checked,
    strokeColor:  document.getElementById('line2-stroke-color')?.value || DEFAULT_TEXT_EFFECTS.line2.strokeColor,
    strokeWidth:  parseFloat(document.getElementById('line2-stroke-width')?.value || String(DEFAULT_TEXT_EFFECTS.line2.strokeWidth)),
  };

  return {
    chroma:        chromaValue,
    animation:     document.getElementById('anim-select')?.value      || 'fade',
    style:         document.getElementById('style-select')?.value     || 'gradient',
    accentColor:   document.getElementById('accent-color')?.value     || '#C8A951',
    ltBgColor:     document.getElementById('lt-bg-color')?.value      || '#000000',
    ltBgOpacity:   parseFloat(document.getElementById('lt-bg-opacity')?.value || '0.88'),
    ltWidth:       parseInt(document.getElementById('lt-width')?.value || '100', 10),
    line2Multiline: !!document.getElementById('line2-multiline')?.checked,
    line2MaxLines: parseInt(document.getElementById('line2-max-lines')?.value || '2', 10),
    position:      document.getElementById('position-select')?.value  || 'lower',
    font:          line1Font, // legacy compatibility for templates/saved presets
    line1Font,
    line2Font,
    outputRes:     document.getElementById('output-res')?.value       || '1920x1080',
    textAlign:     alignRadio ? alignRadio.value                      : 'left',
    ltBgImage:     ltBgDataUrl,
    ltBgSize:      document.getElementById('lt-bg-size')?.value       || 'cover',
    ltBgPosition:  document.getElementById('lt-bg-position')?.value   || 'center center',
    ltMinHeight:   parseInt(document.getElementById('lt-min-height')?.value || '0'),
    logoDataUrl:   logoDataUrl,
    logoPosition:  document.getElementById('logo-position')?.value    || 'left',
    logoSize:      parseInt(document.getElementById('logo-size')?.value || '110'),
    textEffects:   { line1: line1Fx, line2: line2Fx },
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
  // Do not mutate live output styling mid-air; apply on next CUT.
  if (!overlayVisible && !tickerActive) {
    broadcast({ action: 'settings', settings });
  }
  persistSettings(settings);
  // Toggle transparent-mode helper note
  const note = document.getElementById('chroma-transparent-note');
  if (note) note.style.display = (settings.chroma === 'transparent') ? '' : 'none';
}

function syncCurrentStateToOutputs() {
  const settings = getSettings();
  if (!overlayVisible && !tickerActive) {
    broadcast({ action: 'settings', settings });
  }
  if (tickerActive) {
    broadcast({ action: 'show-ticker', data: buildTickerData() });
  } else {
    broadcast({ action: 'clear-ticker' });
  }
  if (overlayVisible) {
    // Keep output aligned to what is actually live in PGM.
    const liveOverlayData = programOverlayData || buildOverlayData();
    broadcast({ action: 'show', data: liveOverlayData, settings });
  } else {
    broadcast({ action: 'clear' });
  }
}

function onCustomChromaChange() {
  const customRadio = document.querySelector('input[name="chroma"][value="custom"]');
  if (customRadio) customRadio.checked = true;
  onSettingsChange();
}

function persistSettings(settings) {
  try {
    const mode = getOverlayStyleModeForEditing();
    if (mode === 'bible' || mode === 'speaker') {
      overlayModeSettings[mode] = pickModeDependentSettings(settings);
      activeOverlaySettingsMode = mode;
      localStorage.setItem(
        OVERLAY_MODE_SETTINGS_KEY_PREFIX + SESSION_ID,
        JSON.stringify(overlayModeSettings)
      );
    }

    const small = { ...settings, ltBgImage: null, logoDataUrl: null };
    MODE_DEPENDENT_SETTING_KEYS.forEach((k) => { delete small[k]; });
    localStorage.setItem('overlaySettings-' + SESSION_ID, JSON.stringify(small));

    // Keep custom template global so it survives new sessions/tabs.
    if (settings.customTemplate && (settings.customTemplate.html || settings.customTemplate.css)) {
      localStorage.setItem(GLOBAL_TEMPLATE_KEY, JSON.stringify(settings.customTemplate));
    }
    if (settings.ltBgImage)   localStorage.setItem('overlayLtBg-'  + SESSION_ID, settings.ltBgImage);
    if (settings.logoDataUrl) localStorage.setItem('overlayLogo-'  + SESSION_ID, settings.logoDataUrl);
  } catch (_) {}
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('overlaySettings-' + SESSION_ID) || '{}');
    const globalTemplate = JSON.parse(localStorage.getItem(GLOBAL_TEMPLATE_KEY) || 'null');

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

    // Restore custom template
    const templateToRestore = saved.customTemplate || globalTemplate;
    if (templateToRestore) {
      const enableEl = document.getElementById('use-custom-template');
      const htmlEl   = document.getElementById('template-html');
      const cssEl    = document.getElementById('template-css');
      if (enableEl && templateToRestore.enabled !== undefined) enableEl.checked = templateToRestore.enabled;
      if (htmlEl   && templateToRestore.html    !== undefined) htmlEl.value    = templateToRestore.html;
      if (cssEl    && templateToRestore.css     !== undefined) cssEl.value     = templateToRestore.css;
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

    const storedModeSettings = JSON.parse(localStorage.getItem(OVERLAY_MODE_SETTINGS_KEY_PREFIX + SESSION_ID) || 'null');
    const fallbackModeSettings = pickModeDependentSettings(saved);

    overlayModeSettings = {
      bible: storedModeSettings?.bible
        ? { ...defaultOverlayModeSettings, ...storedModeSettings.bible }
        : { ...defaultOverlayModeSettings, ...fallbackModeSettings },
      speaker: storedModeSettings?.speaker
        ? { ...defaultOverlayModeSettings, ...storedModeSettings.speaker }
        : { ...defaultOverlayModeSettings, ...fallbackModeSettings },
    };

    activeOverlaySettingsMode = 'bible';
    applyModeDependentSettingsToUi('bible');

  } catch (_) {}
  updateTextEffectLabels();
  onLtBgOpacityInput();
  onLtWidthInput();
  onLine2MaxLinesInput();
  onTickerSizeInput();
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

function setTextEffectsUI(textEffects) {
  const l1 = { ...DEFAULT_TEXT_EFFECTS.line1, ...(textEffects?.line1 || {}) };
  const l2 = { ...DEFAULT_TEXT_EFFECTS.line2, ...(textEffects?.line2 || {}) };
  if (typeof l1.strokeEnabled === 'undefined') l1.strokeEnabled = (parseFloat(l1.strokeWidth) || 0) > 0;
  if (typeof l2.strokeEnabled === 'undefined') l2.strokeEnabled = (parseFloat(l2.strokeWidth) || 0) > 0;
  if (typeof l1.shadowEnabled === 'undefined') l1.shadowEnabled = true;
  if (typeof l2.shadowEnabled === 'undefined') l2.shadowEnabled = true;
  populateFontWeightSelect('line1', l1.fontWeight);
  populateFontWeightSelect('line2', l2.fontWeight);

  const map = [
    ['line1-font-weight', l1.fontWeight],
    ['line1-italic', !!l1.italic],
    ['line1-font-scale', l1.fontScale],
    ['line1-custom-color', !!l1.useCustomColor],
    ['line1-font-color', l1.fontColor],
    ['line1-shadow-enabled', !!l1.shadowEnabled],
    ['line1-shadow-color', l1.shadowColor],
    ['line1-shadow-angle', l1.shadowAngle],
    ['line1-shadow-depth', l1.shadowDepth],
    ['line1-shadow-blur', l1.shadowBlur],
    ['line1-shadow-opacity', l1.shadowOpacity],
    ['line1-stroke-enabled', !!l1.strokeEnabled],
    ['line1-stroke-color', l1.strokeColor],
    ['line1-stroke-width', l1.strokeWidth],
    ['line2-font-weight', l2.fontWeight],
    ['line2-italic', !!l2.italic],
    ['line2-font-scale', l2.fontScale],
    ['line2-custom-color', !!l2.useCustomColor],
    ['line2-font-color', l2.fontColor],
    ['line2-shadow-enabled', !!l2.shadowEnabled],
    ['line2-shadow-color', l2.shadowColor],
    ['line2-shadow-angle', l2.shadowAngle],
    ['line2-shadow-depth', l2.shadowDepth],
    ['line2-shadow-blur', l2.shadowBlur],
    ['line2-shadow-opacity', l2.shadowOpacity],
    ['line2-stroke-enabled', !!l2.strokeEnabled],
    ['line2-stroke-color', l2.strokeColor],
    ['line2-stroke-width', l2.strokeWidth],
  ];
  map.forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (!el || value === undefined || value === null) return;
    if (el.type === 'checkbox') {
      el.checked = !!value;
    } else {
      el.value = String(value);
    }
  });
  updateTextFxSectionState('line1', 'stroke');
  updateTextFxSectionState('line1', 'shadow');
  updateTextFxSectionState('line2', 'stroke');
  updateTextFxSectionState('line2', 'shadow');
}

function updateTextEffectLabels() {
  const defs = [
    ['line1-font-scale', 'line1-font-scale-val', '×'],
    ['line1-shadow-angle', 'line1-shadow-angle-val', '°'],
    ['line1-shadow-depth', 'line1-shadow-depth-val', 'px'],
    ['line1-shadow-blur', 'line1-shadow-blur-val', 'px'],
    ['line1-shadow-opacity', 'line1-shadow-opacity-val', ''],
    ['line1-stroke-width', 'line1-stroke-width-val', 'px'],
    ['line2-font-scale', 'line2-font-scale-val', '×'],
    ['line2-shadow-angle', 'line2-shadow-angle-val', '°'],
    ['line2-shadow-depth', 'line2-shadow-depth-val', 'px'],
    ['line2-shadow-blur', 'line2-shadow-blur-val', 'px'],
    ['line2-shadow-opacity', 'line2-shadow-opacity-val', ''],
    ['line2-stroke-width', 'line2-stroke-width-val', 'px'],
  ];
  defs.forEach(([inputId, labelId, suffix]) => {
    const input = document.getElementById(inputId);
    const label = document.getElementById(labelId);
    if (input && label) label.textContent = `${input.value}${suffix}`;
  });
}

function onTextFxRangeInput(inputId, labelId, suffix = '') {
  const input = document.getElementById(inputId);
  const label = document.getElementById(labelId);
  if (input && label) label.textContent = `${input.value}${suffix}`;
  onSettingsChange();
}

// ── Custom Template Examples ──────────────────────────────────────────────────
// Template variables: {{line1}} {{line2}} {{accentColor}} {{font}} {{line1Font}} {{line2Font}}
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

function renderTemplatePresets() {
  const sel = document.getElementById('template-preset-select');
  if (!sel) return;
  sel.innerHTML = '';

  if (!templatePresets.length) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'No template presets yet';
    sel.appendChild(empty);
    return;
  }

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select template preset...';
  sel.appendChild(placeholder);

  templatePresets.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  });
}

function saveTemplatePreset() {
  const html = document.getElementById('template-html')?.value || '';
  const css  = document.getElementById('template-css')?.value || '';
  const enabled = !!document.getElementById('use-custom-template')?.checked;
  if (!html.trim() && !css.trim()) {
    alert('Template is empty. Add HTML or CSS before saving.');
    return;
  }

  const label = prompt('Template preset name:', 'Custom Template');
  if (label === null || !label.trim()) return;

  templatePresets.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    label: label.trim(),
    template: { html, css, enabled },
  });

  savePresetsToStorage();
  renderTemplatePresets();
  onSettingsChange();
}

function loadSelectedTemplatePreset() {
  const id = document.getElementById('template-preset-select')?.value;
  if (!id) return;
  const preset = templatePresets.find(p => p.id === id);
  if (!preset || !preset.template) return;

  const enableEl = document.getElementById('use-custom-template');
  const htmlEl   = document.getElementById('template-html');
  const cssEl    = document.getElementById('template-css');
  if (enableEl) enableEl.checked = !!preset.template.enabled;
  if (htmlEl)   htmlEl.value = preset.template.html || '';
  if (cssEl)    cssEl.value  = preset.template.css || '';
  onSettingsChange();
}

function deleteSelectedTemplatePreset() {
  const sel = document.getElementById('template-preset-select');
  const id = sel?.value;
  if (!id) return;
  templatePresets = templatePresets.filter(p => p.id !== id);
  savePresetsToStorage();
  renderTemplatePresets();
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
    if (e.key === 'Escape' && isUserGuideOpen()) {
      e.preventDefault();
      closeUserGuide();
      return;
    }

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
      case 'h': case 'H': openUserGuide();                           break;
    }
  });
}
