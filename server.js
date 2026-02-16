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

const PORT = parseInt(process.env.PORT, 10) || 3333;
const ROOT = __dirname;

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
  if (!sessionState.has(sessionId)) sessionState.set(sessionId, { settings: null, show: null });
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

wss.on('connection', (ws, req) => {
  const params    = new URLSearchParams((req.url || '').split('?')[1] || '');
  const sessionId = params.get('session') || 'default';
  const role      = params.get('role')    || 'unknown';

  joinRoom(sessionId, ws);
  const room = rooms.get(sessionId);
  console.log(`  [WS+] ${role.padEnd(8)} session=${sessionId}  (room: ${room ? room.size : 0} clients)`);

  // Replay current state to a newly connected output client so it shows the
  // correct overlay immediately even if it joined after CUT TO AIR was sent.
  if (role === 'output') {
    const state = getState(sessionId);
    if (state.settings) {
      try { ws.send(state.settings); } catch (_) {}
    }
    if (state.show) {
      try { ws.send(state.show); } catch (_) {}
    }
  }

  ws.on('message', raw => {
    // Cache settings and overlay actions so late-joining output clients
    // (e.g. OBS Browser Source) get the current state on connect.
    try {
      const msg = JSON.parse(raw);
      const state = getState(sessionId);
      if (msg.action === 'settings') {
        state.settings = raw.toString();
      } else if (msg.action === 'show') {
        state.show = raw.toString();   // only 'show' is cached; 'clear' leaves it intact
      }
    } catch (_) { /* non-JSON messages are forwarded as-is */ }

    // Relay message to all other clients in the same session room
    broadcastToRoom(sessionId, raw, ws);
  });

  ws.on('close', () => {
    leaveRoom(ws);
    console.log(`  [WS-] ${role.padEnd(8)} session=${sessionId}`);
  });

  ws.on('error', () => leaveRoom(ws));
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n  Shutting down…');
  wss.clients.forEach(c => { try { c.close(); } catch (_) {} });
  server.close(() => process.exit(0));
});

// ── Start ─────────────────────────────────────────────────────────────────────
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
  console.log('\n  Open the Network URL on any device on the same Wi-Fi.');
  console.log('  Each browser tab gets its own session (?session=...).');
  console.log('  Press Ctrl+C to stop.\n');
}
