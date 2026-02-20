# Overlay

Overlay is a browser-based lower-third control app for live production.
Use it to drive an output overlay for:
- Bible references
- Speaker lower thirds
- Ticker messages

It is designed for OBS, vMix, Wirecast, and browser-based output workflows.

> “Freely you have received; freely give.”  
> - Matthew 10:8

## Live Demo

Try it here: `https://overlay.simplifyed.in`

## What You Can Do

- Switch between `Bible Reference`, `Speaker`, and `Ticker` modes.
- Preview (`PVW`) and Program (`PGM`) before and after `CUT TO AIR`.
- Fetch verse text from free sources with fallback support.
- Use multilingual Bible references (including Indian languages in the translation list).
- Hide translation line, append abbreviation on line 1, or use verse text as line 2.
- Use separate text styling per line:
  - font family
  - supported font weights
  - italic
  - size scale
  - color
  - shadow controls
  - stroke controls
- Use built-in lower-third styles plus custom HTML/CSS templates.
- Save and reuse:
  - Reference presets
  - Speaker presets
  - Ticker presets
  - Template presets
  - Global Settings Profiles (save/load/export/import full session state)
- Use multiple sessions via URL session ID.

## Current Default Behavior

- Default Bible reference: `John 3:16-18`
- Default translation selector: `None (hide translation)`
- Translation line (Line 2) is hidden by default
- `Use verse text as line 2` is unchecked by default
- Default ticker text:
  - `The Live Stream has been restored. Thank you for your patience, and our sincere apologies for the interruption.`
- Default ticker style: `Dark`
- Settings panel starts collapsed on load
- In Speaker mode, `CUT TO AIR` is blocked/disabled until Speaker Name is entered

## Quick Start

### 1) Install

```bash
npm install
```

### 2) Run

```bash
npm start
```

Server starts at:
- `http://localhost:3333`

Open:
- Control UI: `http://localhost:3333/`
- Output window: `http://localhost:3333/output.html?session=<session-id>`

## Ubuntu Server Install (Automated)

This project now includes a **two-stage server installer**:

- `scripts/bootstrap_ubuntu_server.sh`
  - updates server packages
  - installs git/curl
  - clones/updates the repo in `/opt/overlay`
  - launches main installer
- `scripts/install_ubuntu_server.sh`
  - prompts only for:
    - domain
    - Let's Encrypt email
  - auto-detects repo/branch from git
  - uses fixed deployment defaults:
    - app dir: `/opt/overlay`
    - app user: `overlay`
    - app port: `3333`
    - systemd service: `overlay`
  - configures Node, npm deps, systemd, Nginx, HTTPS

### Prerequisites

1. Ubuntu server with sudo/root access.
2. DNS `A` record already pointing your domain to the server public IP.
3. Ports `80` and `443` open in cloud/network firewall.

### Recommended one-command install

```bash
curl -fsSL https://raw.githubusercontent.com/jabez4jc/Overlay/main/scripts/bootstrap_ubuntu_server.sh | sudo bash
```

What this command does:
1. Runs `apt-get update && apt-get upgrade`
2. Installs git/curl
3. Clones/updates the app at `/opt/overlay`
4. Runs the interactive installer (`install_ubuntu_server.sh`)

### Manual install path (if you prefer)

```bash
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y git curl ca-certificates
sudo git clone https://github.com/jabez4jc/Overlay.git /opt/overlay
cd /opt/overlay
sudo bash scripts/install_ubuntu_server.sh
```

### Result

After successful install:
- Control UI: `https://<your-domain>/`
- Output URL format: `https://<your-domain>/output.html?session=<session-id>`

Useful operations:

```bash
sudo systemctl status overlay
sudo systemctl restart overlay
sudo journalctl -u overlay -f
sudo nginx -t && sudo systemctl reload nginx
```

## Deploy on Coolify

Overlay can be deployed directly as a Node application on Coolify.

### 1) Create application

1. In Coolify, create a new **Application**.
2. Connect/select repo: `https://github.com/jabez4jc/Overlay`
3. Select branch: `main`
4. Build pack: `Nixpacks` (Node)

### 2) Build and runtime settings

Use:
- Install command: `npm ci` (or `npm install`)
- Build command: *(leave empty)*
- Start command: `npm start`
- Port: `3333`

Notes:
- `server.js` reads `PORT` from environment (`process.env.PORT`) with fallback `3333`.
- Coolify reverse proxy supports WebSockets, which this app needs for control/output sync.

### 3) Domain and HTTPS

1. Attach your domain in Coolify.
2. Enable HTTPS/SSL (Let's Encrypt in Coolify).
3. Deploy/redeploy the application.

After deploy:
- Control UI: `https://<your-domain>/`
- Output URL format: `https://<your-domain>/output.html?session=<session-id>`

### 4) OBS/vMix Browser Source

Use the output URL above as Browser Source URL in OBS/vMix/Wirecast.

## OBS / vMix / Wirecast Setup

1. Open the control UI.
2. Copy the output URL from `Settings -> Browser Source Setup`.
3. Add that URL as a Browser Source in OBS/vMix.
4. Set source resolution to match your output resolution.
5. Use either:
   - transparent mode, or
   - chroma background with keying in your video software.

## Basic Operation

1. Choose a mode (`Bible`, `Speaker`, `Ticker`).
2. Enter data.
3. Confirm in `PVW`.
4. Click `CUT TO AIR`.
5. Use `CLEAR` to remove live overlay/ticker.

## Compact UI Notes

- Bible controls are compacted into 3 logical rows on desktop.
- Speaker Name and Title are on one row on desktop.
- Ticker message is row 1, and badge/speed/style/position are row 2 on desktop.
- Mobile layout stacks controls responsively for small screens.

## Keyboard Shortcuts

- `Enter`: Cut to Air
- `Esc`: Clear
- `B`: Bible mode
- `S`: Speaker mode
- `T`: Ticker mode

## Screenshots (Placeholders)

Add screenshots to `assets/screenshots/` and update paths as needed.

- Control UI (Bible mode)
  - `![Control UI - Bible](assets/screenshots/placeholder-control-bible.png)`
- Speaker mode
  - `![Speaker Mode](assets/screenshots/placeholder-speaker.png)`
- Ticker mode
  - `![Ticker Mode](assets/screenshots/placeholder-ticker.png)`
- Settings panel
  - `![Settings Panel](assets/screenshots/placeholder-settings.png)`
- Text effects (per-line)
  - `![Text Effects](assets/screenshots/placeholder-text-effects.png)`
- Custom template editor
  - `![Custom Template](assets/screenshots/placeholder-custom-template.png)`
- Output window example
  - `![Output Window](assets/screenshots/placeholder-output.png)`

## Project Structure

- `index.html` -> Control UI
- `output.html` -> Output renderer (Browser Source target)
- `js/control.js` -> Control logic, presets, settings profiles, sync
- `js/data.js` -> Bible books, translations, language/font metadata
- `server.js` -> Static hosting + WebSocket relay + scripture proxy endpoints
- `css/control.css` -> Control UI styles
- `scripts/bootstrap_ubuntu_server.sh` -> Bootstrap (update server, install git/curl, clone repo, run installer)
- `scripts/install_ubuntu_server.sh` -> Main Ubuntu installer (Nginx + HTTPS + systemd)

## Notes

- Node.js `>=16` required.
- For cross-device control and Browser Source sync, run through `server.js` (HTTP), not `file://`.

## Copyright and License

- Copyright © 2026 **Jabez Vettriselvan**
- License: `AGPL-3.0-only` (see `LICENSE`)
- Ownership: License and copyright are owned by **Jabez Vettriselvan**.
- This application must always remain free software.
- Modified/redistributed/hosted versions must remain under `AGPL-3.0-only`.
