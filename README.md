# Overlay

Overlay is a browser-based lower-third control application for live production.
It supports Bible references, speaker overlays, and ticker messages with live PVW/PGM workflow.

Live demo: `https://overlay.simplifyed.in`

> “Freely you have received; freely give.”  
> - Matthew 10:8

## Quick Start

1. Install dependencies:
```bash
npm install
```
2. Start server:
```bash
npm start
```
3. Open:
- Control: `http://localhost:3333/`
- Output: `http://localhost:3333/output.html?session=<session-id>`

## Core Workflow

1. Select mode: `Bible Reference`, `Speaker`, or `Ticker`.
2. Enter content and verify in `PVW`.
3. Click `CUT TO AIR` to send to `PGM` and output.
4. Click `CLEAR` to remove live output.

Keyboard shortcuts:
- `Enter`: Cut to Air
- `Esc`: Clear
- `B`: Bible mode
- `S`: Speaker mode
- `T`: Ticker mode
- `O`: Open Output Window
- `H`: Open User Guide

## In-App User Guide

A detailed user guide is now available inside the app:
- Click `User Guide` in the top-right header.
- It includes setup, operating flows, style controls, ATEM usage, and troubleshooting.

## Features

- Bible lookup with free-source fallback support.
- Multi-session operation via `?session=<id>`.
- PVW/PGM monitoring with CUT/CLEAR workflow.
- Lower-third style library including scripture/high-capacity and modern inline variants.
- Per-line text effects:
  - independent fonts for line 1 and line 2
  - supported font weights
  - italic
  - font scaling
  - custom colors
  - stroke and drop shadow
- Custom HTML/CSS template mode.
- Custom lower-third image background and transparent logo support.
- Presets and profiles:
  - Reference presets
  - Speaker presets
  - Ticker presets
  - Template presets
  - Global Settings Profiles (Save/Load/Export/Import)

## Output Setup (OBS/vMix/Wirecast)

Use `Settings -> Output Setup -> Browser Source`:
1. Copy `Output URL`.
2. Add as Browser Source in OBS/vMix/Wirecast.
3. Match source resolution to selected output resolution.
4. Choose keying method:
- `Transparent` chroma mode for alpha browser workflows.
- Blue/Green/Magenta for chroma-key workflows.

## ATEM PNG Export

Use `Settings -> Output Setup -> ATEM PNG Export`.

- `ATEM PNG URL (Premultiplied)`
  - For ATEM media/key workflows that expect premultiplied alpha.
- `Preview PNG URL (Straight)`
  - For browser visual comparison with output rendering.
- `Regenerate`
  - Forces immediate PNG render.

Additional URL variants:
- `/atem-live/<session>.png?alpha=premultiplied`
- `/atem-live/<session>.png?alpha=straight`

## Defaults

- Default reference: `John 3:16-18`
- Default translation selector: `None (hide translation)`
- `Hide translation line (Line 2)`: enabled by default
- `Use verse text as line 2`: disabled by default
- Default ticker style: `Dark`
- Default ticker text:
  - `The Live Stream has been restored. Thank you for your patience, and our sincere apologies for the interruption.`
- Settings panel starts collapsed.

## Deploy on Ubuntu (Automated)

### One-command bootstrap
```bash
curl -fsSL https://raw.githubusercontent.com/jabez4jc/Overlay/main/scripts/bootstrap_ubuntu_server.sh | sudo bash
```

### What it does
- Updates server packages
- Installs `git` and `curl`
- Clones/updates repo in `/opt/overlay`
- Runs installer script for Node/systemd/Nginx/HTTPS

### Manual path
```bash
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y git curl ca-certificates
sudo git clone https://github.com/jabez4jc/Overlay.git /opt/overlay
cd /opt/overlay
sudo bash scripts/install_ubuntu_server.sh
```

## Deploy on Coolify

- Repo: `https://github.com/jabez4jc/Overlay`
- Branch: `main`
- Build Pack: `Nixpacks (Node)`
- Install command: `npm ci` (or `npm install`)
- Start command: `npm start`
- Port: `3333`

## Project Structure

- `index.html` - Control UI
- `output.html` - Output renderer
- `js/control.js` - Control logic, presets/profiles, sync
- `js/output.js` - Output render logic
- `js/data.js` - Bible/language/font data
- `css/control.css` - Control UI styles
- `css/output.css` - Output styles
- `server.js` - HTTP/WebSocket server + ATEM PNG export
- `scripts/bootstrap_ubuntu_server.sh` - Ubuntu bootstrap
- `scripts/install_ubuntu_server.sh` - Ubuntu installer

## License and Copyright

- Copyright © 2026 **Jabez Vettriselvan**
- License: **AGPL-3.0-only**
- This project must remain free software under AGPL-3.0-only.
