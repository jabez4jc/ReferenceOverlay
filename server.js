#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// server.js  —  Reference Overlay  |  WebSocket + HTTP Server
// ─────────────────────────────────────────────────────────────────────────────
//
//  Usage:
//    npm start            (requires:  npm install  first)
//    node server.js
//    PORT=8080 node server.js   (optional custom port)
//
//  Then open in any browser on your network:
//    http://localhost:3333          ← operator control panel
//    http://<your-ip>:3333          ← tablet / phone remote
//
//  Each session ID (?session=...) isolates one operator's output from others.
//  All connected clients in the same session receive each other's messages.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const axios = require('axios');
const cheerio = require('cheerio');
const { PNG } = require('pngjs');

const PORT = parseInt(process.env.PORT, 10) || 3333;
const ROOT = __dirname;

const ATEM_PNG_EXPORT_ENABLED = process.env.ATEM_PNG_EXPORT !== '0';
const ATEM_PNG_EXPORT_PATH = process.env.ATEM_PNG_PATH
  ? path.resolve(process.env.ATEM_PNG_PATH)
  : path.join(ROOT, 'exports', 'atem-live.png');
const ATEM_PNG_WIDTH = Math.max(320, parseInt(process.env.ATEM_PNG_WIDTH || '1920', 10));
const ATEM_PNG_HEIGHT = Math.max(180, parseInt(process.env.ATEM_PNG_HEIGHT || '1080', 10));
const ATEM_PNG_MODE_RAW = String(process.env.ATEM_PNG_MODE || 'premultiplied').trim().toLowerCase();
const ATEM_PNG_MODE = (ATEM_PNG_MODE_RAW === 'straight' || ATEM_PNG_MODE_RAW === 'premultiplied')
  ? ATEM_PNG_MODE_RAW
  : 'premultiplied';
const ATEM_PNG_SESSION = String(process.env.ATEM_PNG_SESSION || '').trim();
const ATEM_PNG_SESSIONS = String(process.env.ATEM_PNG_SESSIONS || '').trim();
const ATEM_PNG_WEBHOOK_URL = String(process.env.ATEM_PNG_WEBHOOK_URL || '').trim();
const ATEM_PNG_WEBHOOK_TIMEOUT_MS = Math.max(500, parseInt(process.env.ATEM_PNG_WEBHOOK_TIMEOUT_MS || '4000', 10));
const ATEM_PNG_WEBHOOK_BEARER = String(process.env.ATEM_PNG_WEBHOOK_BEARER || '').trim();
const ATEM_PNG_WEBHOOK_SECRET = String(process.env.ATEM_PNG_WEBHOOK_SECRET || '').trim();
const ATEM_PNG_BASE_DIR = path.dirname(ATEM_PNG_EXPORT_PATH);
const ATEM_PNG_BASE_FILE = path.basename(ATEM_PNG_EXPORT_PATH);
const ATEM_PNG_BASE_STEM = ATEM_PNG_BASE_FILE.replace(/\.png$/i, '') || 'atem-live';

function normalizeSessionId(value) {
  const s = String(value || '').trim();
  return s || 'default';
}

function sanitizeSessionForFile(value) {
  return normalizeSessionId(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getAtemExportPathForSession(sessionId) {
  const safe = sanitizeSessionForFile(sessionId);
  return path.join(ATEM_PNG_BASE_DIR, `${ATEM_PNG_BASE_STEM}-${safe}.png`);
}

function getAtemExportPathForSessionVariant(sessionId, variant) {
  const safe = sanitizeSessionForFile(sessionId);
  const v = String(variant || '').trim().toLowerCase();
  if (v !== 'straight' && v !== 'premultiplied') return getAtemExportPathForSession(sessionId);
  return path.join(ATEM_PNG_BASE_DIR, `${ATEM_PNG_BASE_STEM}-${safe}-${v}.png`);
}

function getAtemExportUrlForSession(sessionId) {
  return `/atem-live/${encodeURIComponent(normalizeSessionId(sessionId))}.png`;
}

function parsePinnedSessionList(value) {
  return String(value || '')
    .split(',')
    .map(s => normalizeSessionId(s))
    .filter(Boolean);
}

const atemPngPinnedSessions = new Set([
  ...parsePinnedSessionList(ATEM_PNG_SESSIONS),
  ...(ATEM_PNG_SESSION ? [normalizeSessionId(ATEM_PNG_SESSION)] : []),
]);

let chromium = null;
let exportBrowser = null;
let warnedPlaywrightMissing = false;
const exportSessions = new Map(); // sessionId -> { context, page, timer, running, queued }

try {
  ({ chromium } = require('playwright'));
} catch (_) {
  chromium = null;
}

// YouVersion IDs from Glowstudent777/YouVersion-Core versions.json
const YOUVERSION_VERSION_IDS = {
  'AMP': 1588,
  'AMPC': 8,
  'ASV': 12,
  'B21': 1,
  'BIBEL.HEUTE': 877,
  'BKR': 15,
  'CPDV': 42,
  'CSP': 449,
  'DELUT': 51,
  'HFA': 73,
  'ICL00D': 1196,
  'KJV': 1,
  'LUTHEUTE': 999,
  'MB20': 328,
  'NIV': 111,
  'NLT': 116,
  'GNV': 2163,
  'HINOVBSI': 1683,
  'TAOVBSI': 339,
  'IRVTEL': 1895,
  'MALOVBSI': 1693,
  'MALCLBSI': 1685,
  'NPK': 413,
  'NR06': 122,
  'SEB': 1944,
  'SEBDT': 1944,
  'SLB': 102,
  'SNC': 392,
  'SSV': 331,
  'VULG': 823,
};

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
};

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && reqUrl.pathname === '/atem-live.png') {
    const rawSession = reqUrl.searchParams.get('session');
    if (!rawSession) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Session is required. Use /atem-live/<session>.png or /atem-live.png?session=<session>.');
      return;
    }
    const requestedSession = normalizeSessionId(rawSession);
    const alphaMode = String(reqUrl.searchParams.get('alpha') || '').trim().toLowerCase();
    const target = (alphaMode === 'straight' || alphaMode === 'premultiplied')
      ? getAtemExportPathForSessionVariant(requestedSession, alphaMode)
      : getAtemExportPathForSession(requestedSession);
    fs.readFile(target, (err, data) => {
      if (err) {
        if (ATEM_PNG_EXPORT_ENABLED) {
          try {
            writeTransparentPng(target, ATEM_PNG_WIDTH, ATEM_PNG_HEIGHT);
            data = fs.readFileSync(target);
          } catch (_) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('ATEM export not found');
            return;
          }
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('ATEM export not found');
          return;
        }
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(data);
    });
    return;
  }

  const atemSessionMatch = /^\/atem-live\/([^\/]+)\.png$/i.exec(reqUrl.pathname || '');
  if (req.method === 'GET' && atemSessionMatch) {
    const requestedSession = normalizeSessionId(decodeURIComponent(atemSessionMatch[1] || 'default'));
    const alphaMode = String(reqUrl.searchParams.get('alpha') || '').trim().toLowerCase();
    const target = (alphaMode === 'straight' || alphaMode === 'premultiplied')
      ? getAtemExportPathForSessionVariant(requestedSession, alphaMode)
      : getAtemExportPathForSession(requestedSession);
    fs.readFile(target, (err, data) => {
      if (err) {
        if (ATEM_PNG_EXPORT_ENABLED) {
          try {
            writeTransparentPng(target, ATEM_PNG_WIDTH, ATEM_PNG_HEIGHT);
            data = fs.readFileSync(target);
          } catch (_) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('ATEM export not found');
            return;
          }
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('ATEM export not found');
          return;
        }
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(data);
    });
    return;
  }

  // BibleGateway verse proxy endpoint (used by control.js lookup)
  if (req.method === 'GET' && reqUrl.pathname === '/api/verse') {
    const book    = (reqUrl.searchParams.get('book') || '').trim();
    const chapter = (reqUrl.searchParams.get('chapter') || '').trim();
    const verses  = (reqUrl.searchParams.get('verses') || '').trim();
    const version = (reqUrl.searchParams.get('version') || 'KJV').trim().toUpperCase();

    if (!book || !chapter || !verses) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 400, message: 'Missing required params: book, chapter, verses' }));
      return;
    }

    // Guard against garbage input before forwarding to BibleGateway
    if (!/^[0-9]+(?:[-,][0-9]+)*$/.test(verses)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 400, message: 'Invalid verse reference format' }));
      return;
    }

    try {
      const result = await getBibleGatewayVerse(book, `${chapter}:${verses}`, version);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(result));
      return;
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        code: 502,
        message: 'Verse lookup failed',
        detail: err && err.message ? err.message : 'Unknown error',
      }));
      return;
    }
  }

  // YouVersion verse proxy endpoint (used as an extra free fallback source)
  if (req.method === 'GET' && reqUrl.pathname === '/api/youversion') {
    const book      = (reqUrl.searchParams.get('book') || '').trim();
    const bookAlias = (reqUrl.searchParams.get('book_alias') || '').trim().toUpperCase();
    const chapter   = (reqUrl.searchParams.get('chapter') || '').trim();
    const verses    = (reqUrl.searchParams.get('verses') || '').trim();
    const version   = (reqUrl.searchParams.get('version') || 'NIV').trim().toUpperCase();

    if (!book || !chapter || !verses) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 400, message: 'Missing required params: book, chapter, verses' }));
      return;
    }

    if (!/^[0-9]+$/.test(chapter) || !/^[0-9]+$/.test(verses)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 400, message: 'chapter and verses must be numeric' }));
      return;
    }

    try {
      const result = await getYouVersionVerse({
        book,
        bookAlias: bookAlias || null,
        chapter: parseInt(chapter, 10),
        verse: parseInt(verses, 10),
        version,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(result));
      return;
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        code: 502,
        message: 'YouVersion lookup failed',
        detail: err && err.message ? err.message : 'Unknown error',
      }));
      return;
    }
  }

  // Strip query string, resolve relative paths, prevent directory traversal
  const rawPath  = reqUrl.pathname;
  const safePath = path.normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(ROOT, safePath === '/' || safePath === '' ? 'index.html' : safePath);

  // Only serve files inside ROOT
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found: ' + safePath);
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type':  mime,
      'Cache-Control': 'no-cache',         // always fresh for live use
    });
    res.end(data);
  });
});

async function getBibleGatewayVerse(book, passage, version = 'KJV') {
  // Mirrors Glowstudent777/BibleGateway-API-NPM getVerse() logic.
  const url = `https://www.biblegateway.com/passage/?search=${encodeURIComponent(book + ' ' + passage)}&version=${encodeURIComponent(version)}`;
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      // Browser-like UA reduces anti-bot false positives.
      'User-Agent': 'Mozilla/5.0 (compatible; Overlay/2.0; +https://github.com/jabez4jc/Overlay)',
    },
  });
  const $ = cheerio.load(response.data);

  const passageContent = $('meta[property="og:description"]').attr('content');
  if (!passageContent) {
    throw new Error(`Could not find passage ${book} ${passage} ${version}`);
  }

  let footnotes = '';
  $('.footnotes li').each((_, elem) => {
    footnotes += $(elem).text().trim() + ' ';
  });
  footnotes = footnotes.trim();

  const payload = {
    citation: `${book} ${passage} ${version}`,
    passage: passageContent.trim(),
  };
  if (footnotes) payload.footnotes = footnotes;
  return payload;
}

function cleanYouVersionText(html) {
  return String(html || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+([)"”'’\]\}])/g, '$1')
    .replace(/([.,;:!?'"”’\)\]\}])(?=[A-Za-z0-9(\[\{])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveYouVersion(version) {
  const parsed = parseInt(String(version), 10);
  if (!Number.isNaN(parsed)) return { id: parsed, key: String(version) };
  const key = String(version || 'NIV').toUpperCase();
  return { id: YOUVERSION_VERSION_IDS[key] || 111, key };
}

async function getYouVersionVerse({ book, bookAlias, chapter, verse, version }) {
  const { id: versionId, key: versionKey } = resolveYouVersion(version);
  const alias = (bookAlias || '').trim().toUpperCase();
  if (!alias) throw new Error('Missing/invalid book alias');

  const url = `https://www.bible.com/bible/${versionId}/${alias}.${chapter}.${verse}`;
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Overlay/2.0; +https://github.com/jabez4jc/Overlay)',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const $ = cheerio.load(response.data);

  // Primary parse path: __NEXT_DATA__ (same strategy as YouVersion-Core)
  const nextScript = $('script#__NEXT_DATA__').first();
  if (nextScript.length) {
    const json = JSON.parse(nextScript.html() || '{}');
    const verseData = json?.props?.pageProps?.verses?.[0];
    if (verseData?.content) {
      const text = cleanYouVersionText(cheerio.load(verseData.content).text());
      if (text) {
        const citation = verseData?.reference?.human || `${book} ${chapter}:${verse} ${versionKey}`;
        return { citation, passage: text };
      }
    }
  }

  // Fallback parse path
  const text = cleanYouVersionText($('.text-17').first().text());
  if (!text) throw new Error(`Could not find passage ${book} ${chapter}:${verse} ${versionKey}`);
  return { citation: `${book} ${chapter}:${verse} ${versionKey}`, passage: text };
}

// ── WebSocket Server ──────────────────────────────────────────────────────────
let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch (_) {
  // 'ws' not installed — start HTTP-only mode
  server.listen(PORT, '0.0.0.0', printBanner);
  console.warn('\n  ⚠  WebSocket disabled: run "npm install" to enable remote control.\n');
  return;
}

const wss = new WebSocketServer({ server });

// rooms:        Map<sessionId, Set<WebSocket>>
// sessionState: Map<sessionId, { settings: string|null, show: string|null }>
//   'show' stores only the last 'show' payload — 'clear' does NOT overwrite it,
//   so late-joining output clients (OBS Browser Source) always receive the last
//   live overlay state, not an empty clear.
const rooms        = new Map();
const sessionState = new Map();

function getState(sessionId) {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {
      settings: null,
      show: null,
      showTicker: null,
      overlayVisible: false,
      tickerVisible: false,
    });
  }
  return sessionState.get(sessionId);
}

function joinRoom(sessionId, ws) {
  if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
  rooms.get(sessionId).add(ws);
}

function leaveRoom(ws) {
  for (const [id, clients] of rooms) {
    clients.delete(ws);
    if (clients.size === 0) {
      rooms.delete(id);
      sessionState.delete(id);   // clean up state when room is empty
      clearExportSession(id);
    }
  }
}

function broadcastToRoom(sessionId, payload, sender) {
  const clients = rooms.get(sessionId);
  if (!clients) return;
  for (const client of clients) {
    if (client !== sender && client.readyState === 1 /* OPEN */) {
      try { client.send(payload); } catch (_) {}
    }
  }
}

function broadcastToAllClients(payload) {
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      try { client.send(payload); } catch (_) {}
    }
  }
}

function shouldExportSession(sessionId) {
  if (!atemPngPinnedSessions.size) return true;
  return atemPngPinnedSessions.has(normalizeSessionId(sessionId));
}

function writeTransparentPng(filePath, width, height) {
  const png = new PNG({ width, height });
  png.data.fill(0);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

wss.on('connection', (ws, req) => {
  const params    = new URLSearchParams((req.url || '').split('?')[1] || '');
  const sessionId = params.get('session') || 'default';
  const role      = params.get('role')    || 'unknown';

  joinRoom(sessionId, ws);
  const room = rooms.get(sessionId);
  console.log(`  [WS+] ${role.padEnd(8)} session=${sessionId}  (room: ${room ? room.size : 0} clients)`);

  if (role === 'output') {
    const state = getState(sessionId);
    if (state.settings) {
      try { ws.send(state.settings); } catch (_) {}
    }
    if (state.show) {
      try { ws.send(state.show); } catch (_) {}
    }
    if (state.showTicker) {
      try { ws.send(state.showTicker); } catch (_) {}
    }
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      const state = getState(sessionId);
      if (msg.action === 'atem-export-config') {
        const requestedPin = !!msg.pinCurrentSession;
        const requestedSessionId = normalizeSessionId(msg.sessionId || sessionId || 'default');
        if (requestedPin) atemPngPinnedSessions.add(requestedSessionId);
        else atemPngPinnedSessions.delete(requestedSessionId);

        const ack = JSON.stringify({
          action: 'atem-export-config-ack',
          sessionId: requestedSessionId,
          pinCurrentSession: atemPngPinnedSessions.has(requestedSessionId),
          pinnedSessions: Array.from(atemPngPinnedSessions),
          exportUrl: getAtemExportUrlForSession(requestedSessionId),
        });
        broadcastToAllClients(ack);
        schedulePngExport(requestedSessionId);
      } else if (msg.action === 'atem-export-status') {
        const requestedSessionId = normalizeSessionId(msg.sessionId || sessionId || 'default');
        const ack = JSON.stringify({
          action: 'atem-export-config-ack',
          sessionId: requestedSessionId,
          pinCurrentSession: atemPngPinnedSessions.has(requestedSessionId),
          pinnedSessions: Array.from(atemPngPinnedSessions),
          exportUrl: getAtemExportUrlForSession(requestedSessionId),
        });
        try { ws.send(ack); } catch (_) {}
      } else if (msg.action === 'atem-export-refresh') {
        const requestedSessionId = normalizeSessionId(msg.sessionId || sessionId || 'default');
        schedulePngExport(requestedSessionId);
      } else if (msg.action === 'settings') {
        state.settings = raw.toString();
      } else if (msg.action === 'show') {
        state.show = raw.toString();
        if (msg.settings) state.settings = JSON.stringify(msg.settings);
        state.overlayVisible = true;
      } else if (msg.action === 'clear') {
        state.overlayVisible = false;
      } else if (msg.action === 'show-ticker') {
        state.showTicker = raw.toString();
        state.tickerVisible = true;
      } else if (msg.action === 'clear-ticker') {
        state.tickerVisible = false;
      }

      if (msg.action === 'settings' || msg.action === 'show' || msg.action === 'clear' || msg.action === 'show-ticker' || msg.action === 'clear-ticker') {
        schedulePngExport(sessionId);
      }
    } catch (_) {}

    broadcastToRoom(sessionId, raw, ws);
  });

  ws.on('close', () => {
    leaveRoom(ws);
    console.log(`  [WS-] ${role.padEnd(8)} session=${sessionId}`);
  });

  ws.on('error', () => leaveRoom(ws));
});
function getExportSession(sessionId) {
  if (!exportSessions.has(sessionId)) {
    exportSessions.set(sessionId, {
      context: null,
      page: null,
      timer: null,
      running: false,
      queued: false,
    });
  }
  return exportSessions.get(sessionId);
}

function clearExportSession(sessionId) {
  const exp = exportSessions.get(sessionId);
  if (!exp) return;
  if (exp.timer) clearTimeout(exp.timer);
  exp.timer = null;
  exp.running = false;
  exp.queued = false;
  if (exp.context) {
    exp.context.close().catch(() => {});
  }
  exportSessions.delete(sessionId);
}

async function ensureExporterPage(sessionId) {
  if (!ATEM_PNG_EXPORT_ENABLED) return null;
  if (!chromium) {
    if (!warnedPlaywrightMissing) {
      warnedPlaywrightMissing = true;
      console.warn('  ⚠  ATEM PNG export disabled: install Playwright (npm i playwright and npx playwright install chromium).');
    }
    return null;
  }

  if (!exportBrowser) {
    exportBrowser = await chromium.launch({ headless: true });
  }

  const exp = getExportSession(sessionId);
  if (exp.page) return exp;

  exp.context = await exportBrowser.newContext({
    viewport: { width: ATEM_PNG_WIDTH, height: ATEM_PNG_HEIGHT },
    deviceScaleFactor: 1,
  });
  exp.page = await exp.context.newPage();
  const outputUrl = `http://127.0.0.1:${PORT}/output.html?session=${encodeURIComponent(sessionId)}&exportPng=1`;
  await exp.page.goto(outputUrl, { waitUntil: 'networkidle' });
  return exp;
}

async function applyStateToExportPage(page, state) {
  let settingsPayload = null;
  if (state.settings) {
    try {
      const parsed = JSON.parse(state.settings);
      settingsPayload = (parsed && typeof parsed === 'object' && parsed.settings)
        ? parsed.settings
        : parsed;
    } catch (_) {
      settingsPayload = null;
    }
  }
  if ((!settingsPayload || typeof settingsPayload !== 'object') && state.show) {
    try {
      const parsedShow = JSON.parse(state.show);
      if (parsedShow && typeof parsedShow === 'object' && parsedShow.settings) {
        settingsPayload = parsedShow.settings;
      }
    } catch (_) {}
  }

  let showPayload = null;
  if (state.overlayVisible && state.show) {
    try {
      showPayload = JSON.parse(state.show);
    } catch (_) {
      showPayload = null;
    }
  }

  // When an overlay is live, prefer the exact settings bundled with that live show payload.
  // This keeps ATEM export frame-perfect with what the output window rendered on CUT.
  const effectiveSettings =
    showPayload && showPayload.settings && typeof showPayload.settings === 'object'
      ? showPayload.settings
      : settingsPayload;

  // Prevent stale nested settings from overriding effectiveSettings during replay.
  if (showPayload && Object.prototype.hasOwnProperty.call(showPayload, 'settings')) {
    delete showPayload.settings;
  }

  const replay = {
    settings: effectiveSettings,
    show: showPayload,
    showTicker: state.tickerVisible && state.showTicker ? JSON.parse(state.showTicker) : null,
  };

  await page.evaluate(async payload => {
    if (typeof window.handleMessage !== 'function') return;

    // Freeze all motion/transition so we always capture deterministic final frames.
    let freeze = document.getElementById('atem-export-freeze-style');
    if (!freeze) {
      freeze = document.createElement('style');
      freeze.id = 'atem-export-freeze-style';
      freeze.textContent = '*{animation:none !important;transition:none !important;}';
      document.head.appendChild(freeze);
    }

    document.body.classList.remove('chroma-blue', 'chroma-green', 'chroma-magenta', 'chroma-custom', 'chroma-transparent');
    document.body.style.background = '';

    const watermark = document.getElementById('session-watermark');
    if (watermark) watermark.style.display = 'none';

    // Force animation mode to none for export-only rendering.
    const settings = payload.settings ? { ...payload.settings, animation: 'none' } : null;
    if (settings) window.handleMessage({ action: 'settings', settings });

    if (payload.show) window.handleMessage(payload.show);
    else window.handleMessage({ action: 'clear' });

    if (payload.showTicker) window.handleMessage(payload.showTicker);
    else window.handleMessage({ action: 'clear-ticker' });

    // Ensure fonts and final paint settle before screenshot.
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (_) {}
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    void document.body.offsetWidth;
  }, replay);
}

function premultiplyAlphaPng(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  const data = png.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 255) continue;
    if (a === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      continue;
    }
    data[i] = Math.round((data[i] * a) / 255);
    data[i + 1] = Math.round((data[i + 1] * a) / 255);
    data[i + 2] = Math.round((data[i + 2] * a) / 255);
  }
  return PNG.sync.write(png);
}

async function triggerAtemPngWebhook(sessionId) {
  if (!ATEM_PNG_WEBHOOK_URL) return;

  const normalizedSessionId = normalizeSessionId(sessionId);
  const payload = {
    event: 'atem-png-updated',
    sessionId: normalizedSessionId,
    exportUrl: getAtemExportUrlForSession(normalizedSessionId),
    exportPath: getAtemExportPathForSession(normalizedSessionId),
    mode: ATEM_PNG_MODE,
    pinnedSessions: Array.from(atemPngPinnedSessions),
    timestamp: new Date().toISOString(),
  };

  const headers = {
    'Content-Type': 'application/json',
  };
  if (ATEM_PNG_WEBHOOK_BEARER) headers.Authorization = `Bearer ${ATEM_PNG_WEBHOOK_BEARER}`;
  if (ATEM_PNG_WEBHOOK_SECRET) headers['X-Overlay-Webhook-Secret'] = ATEM_PNG_WEBHOOK_SECRET;

  try {
    const response = await axios.post(ATEM_PNG_WEBHOOK_URL, payload, {
      headers,
      timeout: ATEM_PNG_WEBHOOK_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      console.warn(`  ⚠  ATEM webhook returned HTTP ${response.status}`);
    }
  } catch (err) {
    console.warn(`  ⚠  ATEM webhook failed: ${err && err.message ? err.message : err}`);
  }
}

async function renderPngExport(sessionId) {
  const state = getState(sessionId);
  const exp = await ensureExporterPage(sessionId);
  if (!exp || !exp.page) return;

  await applyStateToExportPage(exp.page, state);
  await exp.page.waitForTimeout(120);
  const exportPath = getAtemExportPathForSession(sessionId);
  const straightPath = getAtemExportPathForSessionVariant(sessionId, 'straight');
  const premultPath = getAtemExportPathForSessionVariant(sessionId, 'premultiplied');
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  const tmpPath = `${exportPath}.tmp`;
  const tmpStraightPath = `${straightPath}.tmp`;
  const tmpPremultPath = `${premultPath}.tmp`;
  const straightBuffer = await exp.page.screenshot({
    type: 'png',
    omitBackground: true,
  });
  const premultBuffer = premultiplyAlphaPng(straightBuffer);

  // Always publish both variants for validation and flexible downstream ingest.
  fs.writeFileSync(tmpStraightPath, straightBuffer);
  fs.writeFileSync(tmpPremultPath, premultBuffer);
  fs.renameSync(tmpStraightPath, straightPath);
  fs.renameSync(tmpPremultPath, premultPath);

  const finalBuffer = ATEM_PNG_MODE === 'premultiplied' ? premultBuffer : straightBuffer;
  fs.writeFileSync(tmpPath, finalBuffer);
  fs.renameSync(tmpPath, exportPath);
  void triggerAtemPngWebhook(sessionId);
}
function schedulePngExport(sessionId) {
  if (!ATEM_PNG_EXPORT_ENABLED) return;
  if (!shouldExportSession(sessionId)) return;
  const exp = getExportSession(sessionId);
  if (exp.timer) clearTimeout(exp.timer);
  exp.timer = setTimeout(async () => {
    exp.timer = null;
    if (exp.running) {
      exp.queued = true;
      return;
    }
    exp.running = true;
    try {
      await renderPngExport(sessionId);
    } catch (err) {
      console.warn(`  ⚠  PNG export failed for session "${sessionId}": ${err && err.message ? err.message : err}`);
    } finally {
      exp.running = false;
      if (exp.queued) {
        exp.queued = false;
        schedulePngExport(sessionId);
      }
    }
  }, 35);
}
// ── Graceful Shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n  Shutting down…');
  wss.clients.forEach(c => { try { c.close(); } catch (_) {} });
  for (const sessionId of exportSessions.keys()) {
    clearExportSession(sessionId);
  }
  const closeBrowser = exportBrowser ? exportBrowser.close().catch(() => {}) : Promise.resolve();
  closeBrowser.finally(() => server.close(() => process.exit(0)));
});

// ── Start ─────────────────────────────────────────────────────────────────────
if (ATEM_PNG_EXPORT_ENABLED) {
  try {
    fs.mkdirSync(ATEM_PNG_BASE_DIR, { recursive: true });
    const seedSessions = Array.from(atemPngPinnedSessions);
    seedSessions.forEach(sessionId => {
      const seedPath = getAtemExportPathForSession(sessionId);
      if (!fs.existsSync(seedPath)) {
        writeTransparentPng(seedPath, ATEM_PNG_WIDTH, ATEM_PNG_HEIGHT);
      }
    });
  } catch (err) {
    console.warn(`  ⚠  Could not initialize ATEM PNG: ${err && err.message ? err.message : err}`);
  }
}
server.listen(PORT, '0.0.0.0', printBanner);

function printBanner() {
  const ifaces  = os.networkInterfaces();
  const lanIPs  = Object.values(ifaces)
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);

  console.log('\n ┌─────────────────────────────────────────────────────┐');
  console.log(' │         Reference Overlay  —  Server Mode           │');
  console.log(' └─────────────────────────────────────────────────────┘\n');
  console.log(`  Local (this machine):   http://localhost:${PORT}`);
  lanIPs.forEach(ip => {
    console.log(`  Network (tablet/phone): http://${ip}:${PORT}`);
  });
  if (ATEM_PNG_EXPORT_ENABLED) {
    console.log(`  ATEM PNG export dir:    ${ATEM_PNG_BASE_DIR}`);
    console.log(`  ATEM PNG URL format:    /atem-live/<session>.png`);
    console.log(`  ATEM preview variants:  ?alpha=straight | ?alpha=premultiplied`);
    console.log(`  ATEM PNG mode:          ${ATEM_PNG_MODE}`);
    console.log(`  ATEM PNG pinned:        ${atemPngPinnedSessions.size ? Array.from(atemPngPinnedSessions).join(', ') : '(all sessions)'}`);
    console.log(`  ATEM PNG webhook:       ${ATEM_PNG_WEBHOOK_URL || '(disabled)'}`);
    if (!chromium) {
      console.log('  (disabled at runtime — install Playwright + Chromium browser)');
    }
  } else {
    console.log('  ATEM PNG export:        disabled (ATEM_PNG_EXPORT=0)');
  }
  console.log('\n  Open the Network URL on any device on the same Wi-Fi.');
  console.log('  Each browser tab gets its own session (?session=...).');
  console.log('  Copyright © 2026 Jabez Vettriselvan.');
  console.log('  “Freely you have received; freely give.” — Matthew 10:8');
  console.log('  Press Ctrl+C to stop.\n');
}
