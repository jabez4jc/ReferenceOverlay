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
const server = http.createServer((req, res) => {
  // Strip query string, resolve relative paths, prevent directory traversal
  const rawPath  = req.url.split('?')[0];
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

// rooms: Map<sessionId, Set<WebSocket>>
const rooms = new Map();

function joinRoom(sessionId, ws) {
  if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
  rooms.get(sessionId).add(ws);
}

function leaveRoom(ws) {
  for (const [id, clients] of rooms) {
    clients.delete(ws);
    if (clients.size === 0) rooms.delete(id);
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

  ws.on('message', raw => {
    // Relay message to all other clients in the same session room
    broadcastToRoom(sessionId, raw, ws);
  });

  ws.on('close', () => {
    leaveRoom(ws);
    console.log(`  [WS-] ${role.padEnd(8)} session=${sessionId}`);
  });

  ws.on('error', () => leaveRoom(ws));
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
