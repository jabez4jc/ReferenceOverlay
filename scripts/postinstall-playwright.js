#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const skip = String(process.env.SKIP_PLAYWRIGHT_INSTALL || '').trim() === '1';
if (skip) {
  console.log('[postinstall] SKIP_PLAYWRIGHT_INSTALL=1 -> skipping Playwright browser install.');
  process.exit(0);
}

let cliPath;
try {
  cliPath = require.resolve('playwright/cli');
} catch (_) {
  console.warn('[postinstall] Playwright package not found; skipping Chromium browser install.');
  process.exit(0);
}

console.log('[postinstall] Installing Playwright Chromium browser for ATEM PNG export...');
const result = spawnSync(process.execPath, [cliPath, 'install', 'chromium'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '0',
  },
});

if (result.status !== 0) {
  console.warn('\n[postinstall] Chromium install failed.');
  console.warn('[postinstall] ATEM PNG export will stay in placeholder mode until Chromium is available.');
  console.warn('[postinstall] You can retry inside the app container with: npx playwright install chromium\n');
  process.exit(0);
}

console.log('[postinstall] Playwright Chromium installed successfully.');
