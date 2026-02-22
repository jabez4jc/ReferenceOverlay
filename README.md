# Overlay

Overlay is a browser-based lower-third control system for live production with synchronized **Control / PVW / PGM / Output** pipelines, multi-session operation, and ATEM-ready PNG export.

Live demo: `https://overlay.simplifyed.in`

> “Freely you have received; freely give.”  
> - Matthew 10:8

## Quick Start

```bash
npm install
npm start
```

Open:
- Control UI: `http://localhost:3333/`
- Output window: `http://localhost:3333/output.html?session=<session-id>`

Use the **same session ID** in both windows.

## Core Live Workflow

1. Select mode: `Bible Reference`, `Speaker`, or `Ticker`.
2. Build and validate content in `PVW`.
3. Click `CUT TO AIR` to move PVW to `PGM` and Output.
4. Click `CLEAR` to remove active lower-third/ticker output.

Keyboard shortcuts:
- `Enter`: Cut to Air
- `Esc`: Clear
- `B`: Bible mode
- `S`: Speaker mode
- `T`: Ticker mode
- `O`: Open Output Window
- `H`: Open User Guide

## Session Model

- Every session is isolated via URL: `?session=<id>`.
- Control and Output must share session ID.
- You can run multiple sessions from one server at the same time.
- You can set a custom session at load time (URL/session switcher).

## Mode Workflows

### Bible Reference

- Set `Book`, `Chapter`, `Verse(s)`, `Translation`, and `Reference Language`.
- Optional toggles:
  - `Hide translation line (Line 2)`
  - `Append translation abbreviation on line 1`
- `Look Up Text` fetches verse text (using configured source/fallback chain).
- `Use verse text as line 2 in output` is intentionally independent from translation visibility.

Recommended runbook:
1. Build reference.
2. Optionally fetch verse text.
3. Confirm line 1/line 2 behavior.
4. Check PVW.
5. Cut to air.

### Speaker

- Enter speaker name (required for meaningful on-air output).
- Role/title is optional.
- Preview first, then cut.

### Ticker

- Set message, badge, speed, style, position, colors, and size.
- Ticker can be operated independently from lower-third overlays.

## Styling System

### Lower Third Styles

- Includes classic, gradient, scripture/high-capacity, and modern inline variants.
- Supports line-1-only and line-1+line-2 workflows.
- Line 2 multiline can be enabled for longer scripture text.

### Text Effects (Per Line)

Each line (Line 1 / Line 2) supports:
- Font family
- Supported font weight (filtered by selected font)
- Italic
- Font size scale
- Custom color
- Stroke (toggle + color + width)
- Drop shadow (toggle + direction/depth/blur/opacity/color)

### Custom Template and Assets

- `Custom HTML Template` can fully override built-in styles.
- Supported variables: `{{line1}}`, `{{line2}}`, `{{accentColor}}`, `{{font}}`, `{{line1Font}}`, `{{line2Font}}`, `{{logoUrl}}`, `{{bgUrl}}`.
- `Custom Image & Logo` supports:
  - Lower-third background image
  - PNG logo with transparency

## Presets and Settings Profiles

### Presets

- Reference presets
- Speaker presets
- Ticker presets
- Template presets

### Settings Profiles

Global Save/Load/Export/Import for:
- Visual settings
- Layout options
- Mode defaults
- Presets bundle

Use profiles for rapid show setup reuse across sessions/devices.

## Output Setup

`Settings -> Output Setup`

### Browser Source Tab

Use this when integrating with OBS/vMix/Wirecast:
1. Copy Output URL.
2. Add as Browser Source.
3. Match source resolution with selected output resolution.
4. Choose keying method:
   - `Transparent` mode for alpha-capable browser pipelines.
   - Blue/Green/Magenta/Custom for chroma-key pipelines.

### ATEM PNG Export Tab

Use this when feeding ATEM media workflow.

- Include/pin current session for export.
- Session-specific URLs are provided.
- Export endpoints support both alpha models:
  - Premultiplied (ATEM production use)
  - Straight (browser QA/comparison)

Typical endpoints:
- `/atem-live.png` (default export)
- `/atem-live/<session>.png`
- `/atem-live/<session>.png?alpha=premultiplied`
- `/atem-live/<session>.png?alpha=straight`

Recommended ATEM runbook:
1. Pin the active session.
2. Cut lower-third to air.
3. Regenerate if you need immediate refresh.
4. Use premultiplied URL for ATEM key workflow.
5. If mismatch is suspected, compare straight variant first in browser.

Note: premultiplied images can look visually different in standard browser preview; validate in the target switcher/key pipeline.

## Defaults

- Default reference: `John 3:16-18`
- Default translation selector: `None (hide translation)`
- `Hide translation line (Line 2)`: enabled by default
- `Use verse text as line 2`: disabled by default
- Default ticker style: `Dark`
- Default ticker text:  
  `The Live Stream has been restored. Thank you for your patience, and our sincere apologies for the interruption.`
- Settings panel default: collapsed/hidden for faster operation

## Deploy

### Ubuntu (Automated)

```bash
curl -fsSL https://raw.githubusercontent.com/jabez4jc/Overlay/main/scripts/bootstrap_ubuntu_server.sh | sudo bash
```

This bootstrap updates the server, installs required tools, clones/updates repo, and runs the full installer (Node, service, Nginx, HTTPS).

Manual path:

```bash
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y git curl ca-certificates
sudo git clone https://github.com/jabez4jc/Overlay /opt/overlay
cd /opt/overlay
sudo bash scripts/install_ubuntu_server.sh
```

### Coolify

Recommended for reliable ATEM PNG export: **Dockerfile deployment** (not Nixpacks).

- Repo: `https://github.com/jabez4jc/Overlay`
- Branch: `main`
- Build Pack: **Dockerfile**
- Dockerfile Path: `./Dockerfile`
- Port: `3333`

Why Dockerfile mode:
- Uses Playwright official runtime image with Chromium + required OS libraries preinstalled.
- Avoids runtime dependency gaps that cause ATEM PNG to stay in placeholder mode.

Coolify settings:
1. Expose port `3333`.
2. Add domain (for example `overlay.simplifyed.in`).
3. Keep persistent storage optional (not required for operation).
4. Optional env vars:
   - `ATEM_PNG_MODE=premultiplied`
   - `ATEM_PNG_SESSIONS=<comma-separated-session-ids>` if you want pre-pinned sessions.

If you still prefer Nixpacks:
- Keep install command as `npm ci` (do not use `--ignore-scripts`).
- Ensure postinstall logs show Chromium installed.
- If browser download is blocked, ATEM export will remain placeholder-only.

## Troubleshooting

- Output not syncing:
  - Confirm same session ID in Control and Output URLs.
  - Confirm active WebSocket connection.
- PVW/PGM vs Output mismatch:
  - Verify mode and active cut state.
  - Confirm custom template is not overriding expected style.
- ATEM PNG mismatch:
  - Regenerate export.
  - Compare `?alpha=straight` vs `?alpha=premultiplied`.
  - Validate with actual ATEM key settings.
- Mobile UX issues:
  - Keep settings collapsed unless editing.
  - Use User Guide (`H`) for fast-operate workflow.

## Project Structure

- `index.html` - Control UI
- `output.html` - Output renderer
- `js/control.js` - control logic, sync, presets/profiles
- `js/output.js` - output rendering logic
- `js/data.js` - Bible data, translation/font metadata
- `css/control.css` - control styles
- `css/output.css` - output styles
- `server.js` - HTTP/WebSocket + ATEM PNG export pipeline
- `scripts/bootstrap_ubuntu_server.sh` - Ubuntu bootstrap
- `scripts/install_ubuntu_server.sh` - Ubuntu installer

## License and Copyright

- Copyright © 2026 **Jabez Vettriselvan**
- License: **AGPL-3.0-only**
- This project remains free software under AGPL-3.0-only.
