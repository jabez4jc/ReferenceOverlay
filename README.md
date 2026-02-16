# Reference Overlay

A browser-based lower-third overlay controller for live video production.
Display **Bible references**, **speaker names**, or **news-ticker alerts** as a real-time
overlay in OBS, vMix, Wirecast, or an ATEM switcher — controlled from any device on your
network.

---

## Features

- **Three overlay modes** — Bible Reference, Speaker / Lower Third, News Ticker
- **8 lower-third styles** — Classic, Accent Line, Minimal, Outline, Gradient Fade, Solid, Split Lines, Frosted Glass
- **Custom HTML/CSS templates** — full code editor with live preview and built-in examples
- **Logo & background image** — upload per-session with position and fit controls
- **40+ Bible translations** — with live verse-text lookup (free and premium tiers)
- **Real-time sync** — WebSocket server relays messages across applications and devices
- **OBS/vMix Browser Source** — transparent mode or chroma key, state replayed on connect
- **Presets** — save, load, export, and import reference and ticker presets
- **Multi-device control** — run the control panel on a phone or tablet, output in OBS
- **Session isolation** — multiple operators work independently on the same server
- **Session watermark** — toggle session ID display on the output window for easy pairing
- **Keyboard shortcuts** — CUT, CLEAR, mode switch, output open
- **Fully offline** — no CDN dependencies after `npm install`

---

## How It Works

Two browser windows (or browser tabs) communicate through one of four channels,
depending on how the app is deployed:

| Channel | When used |
|---|---|
| **WebSocket** (via `server.js`) | Control panel + OBS Browser Source on different apps or devices |
| **BroadcastChannel** | Two tabs in the same browser (same origin) |
| **postMessage** | Control panel → Output window opened with the built-in "↗ Output" button |
| **localStorage** | Fallback / state persistence across reloads |

For OBS, vMix, or Wirecast **Browser Source** integration the WebSocket server is
**required** — it is the only channel that crosses application boundaries.

```
┌─────────────────┐        WebSocket        ┌──────────────────┐
│  Control Panel  │ ──── node server.js ──▶  │  Output Window   │
│  (your browser) │                          │  (OBS / browser) │
└─────────────────┘                          └──────────────────┘
```

The output window displays a solid-colour **chroma key background** (or transparent)
so your switcher can key out the background, leaving only the overlay graphic floating
over your live video.

---

## Installation

### Option A — Local files, no server (simplest)

> Best for: single-machine use, operator controls and output on the same computer.

1. Download or clone this repository.
2. Open `index.html` in **Chrome** or **Edge** directly from the file system.
3. Click the **↗ Output** button — a second window opens ready for capture.
4. Add that window as a **Window Capture** source in OBS/Wirecast and apply a Chroma Key filter.

> **Limitation:** The output window opened this way communicates via `postMessage` /
> `BroadcastChannel`. OBS's built-in Browser Source **cannot** receive those messages.
> Use Option B if you need Browser Source integration.

---

### Option B — Local Node.js server (recommended for OBS Browser Source)

> Best for: OBS Browser Source, phone/tablet remote control, most production setups.

**Prerequisites:** [Node.js](https://nodejs.org) v16 or later.

```bash
# 1. Install the single dependency (run once)
npm install

# 2. Start the server
node server.js
# or: npm start
```

The terminal prints:

```
  Local (this machine):   http://localhost:3333
  Network (tablet/phone): http://192.168.x.x:3333
```

3. Open the control panel at `http://localhost:3333/` in your browser.
   Note the **session ID** badge (e.g. `#a3f9c2`) in the top-right corner.
4. Copy the **Browser Source URL** from **Settings → Browser Source Setup** inside the
   control panel — it looks like `http://localhost:3333/output.html?session=a3f9c2`.
5. In OBS: **Sources → + → Browser** → paste the URL → set Width/Height to your canvas
   resolution → click **OK**.
6. Verify the server terminal shows both clients connected in the same room:
   ```
   [WS+] control  session=a3f9c2  (room: 1 clients)
   [WS+] output   session=a3f9c2  (room: 2 clients)
   ```
7. Type a reference in the control panel and click **CUT TO AIR**.

The server must be running the entire time you are using the overlay.
Stop it with `Ctrl+C` when you are done.

---

### Option C — Linux server with a custom domain

> Best for: permanent install accessible over the internet or your organisation's LAN.

This setup uses **Nginx** as a reverse proxy in front of the Node.js server, with
**Let's Encrypt** for HTTPS. Nginx handles the WebSocket upgrade transparently.

#### 1 — Install Node.js and the app

```bash
# Install Node.js (Debian / Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone the repository
git clone https://github.com/your-org/reference-overlay.git /var/www/reference-overlay
cd /var/www/reference-overlay
npm install
```

#### 2 — Create a systemd service

This keeps the server running after reboots and restarts it on failure.

Create `/etc/systemd/system/reference-overlay.service`:

```ini
[Unit]
Description=Reference Overlay WebSocket server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/reference-overlay
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=3333

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable reference-overlay
sudo systemctl start reference-overlay
sudo systemctl status reference-overlay    # confirm it is running
```

#### 3 — Configure Nginx

Install Nginx and Certbot if not already present:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/reference-overlay`:

```nginx
server {
    listen 80;
    server_name overlay.yourdomain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name overlay.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/overlay.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/overlay.yourdomain.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Proxy all HTTP requests to Node.js
    location / {
        proxy_pass         http://127.0.0.1:3333;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # WebSocket upgrade (required)
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_read_timeout 86400s;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/reference-overlay \
           /etc/nginx/sites-enabled/reference-overlay
sudo nginx -t                                              # confirm no syntax errors
sudo systemctl reload nginx
```

#### 4 — Obtain an SSL certificate

```bash
sudo certbot --nginx -d overlay.yourdomain.com
```

Follow the prompts. Certbot auto-renews the certificate via a cron job.

#### 5 — Open your firewall

```bash
sudo ufw allow 'Nginx Full'
sudo ufw reload
```

The control panel is now at `https://overlay.yourdomain.com/` and the Browser Source
URL is `https://overlay.yourdomain.com/output.html?session=XXXX`.

> **Note:** The Node.js server uses plain `ws://` internally, but Nginx upgrades the
> connection to `wss://` for outside clients automatically via the proxy configuration
> above. No changes to `server.js` are needed.

---

### Option D — Static cloud hosting (Netlify / Vercel / GitHub Pages)

> Best for: single-machine demos where both tabs are in the same browser.
> **Not suitable** for OBS Browser Source or cross-device control — those require
> a persistent WebSocket server, which static hosts do not provide.

Upload the static files only (no `server.js` or `node_modules`):

**Netlify** — drag the project folder to [app.netlify.com/drop](https://app.netlify.com/drop)

**Vercel:**
```bash
npm install -g vercel
vercel deploy
```

**GitHub Pages:**
```bash
git checkout -b gh-pages
git push origin gh-pages
```

Once deployed, open the URL in two browser tabs — one for the control panel, one for
the output (`/output.html?session=XXXX`). `BroadcastChannel` keeps them in sync within
the same browser. If you need OBS Browser Source, deploy Option B or C instead.

---

## Connecting to Broadcast Equipment

### OBS Studio

1. Run the Node.js server (Option B or C).
2. In OBS: **Sources → + → Browser**
3. Paste the URL from **Settings → Browser Source Setup** in the control panel.
4. Set **Width / Height** to match your OBS canvas (e.g. 1920 × 1080).
5. Choose one of the two keying methods:

   **Transparent mode (no filter needed — recommended):**
   - In the control panel Settings, select **Chroma Key Background → Transparent**.
   - In OBS Browser Source properties, tick **Allow transparency**.
   - No filter required. The overlay composites cleanly with correct alpha.

   **Chroma Key filter (works on all OBS versions):**
   - In the control panel Settings, select Blue, Green, or Magenta.
   - Right-click the Browser Source → **Filters → + → Chroma Key**.
   - Set **Key Color Type** to match your chosen background colour.

6. Click **OK**. The server terminal should show `room: 2 clients` for your session.
7. Type a reference and click **CUT TO AIR**.

### Wirecast

1. Add a **Window Capture** shot layer pointing to an open Output Window
   (opened with the **↗ Output** button in the control panel).
2. In the shot layer properties, add a **Chroma Key** filter.
3. Set the colour to match the selected background (Blue / Green / Magenta).

### vMix

1. **Add Input → Browser** → paste the URL from **Settings → Browser Source Setup**.
2. Set resolution to match your vMix output.
3. Add a **Chroma Key** colour correction effect, or enable **Transparent** mode and
   use vMix's alpha compositing.

### ATEM Switchers

1. On the operator machine, open the Output Window via the **↗ Output** button.
2. Resize the window to exactly your programme resolution (e.g. 1920 × 1080).
3. In **ATEM Software Control → Upstream Key**:
   - Source: screen/window capture of the Output Window.
   - Key Type: **Luma** or **Chroma**.
   - Chroma colour: match the selected background.
4. Enable the key on the desired M/E bus.

---

## Modes

### Bible Reference

| Field | Notes |
|---|---|
| **Book** | All 66 books, grouped by Old / New Testament |
| **Chapter** | Chapter number (1 to maximum for the book) |
| **Verse** | Supports single (`3`), ranges (`3–5`), and mixed (`3, 5–7, 10`) |
| **Translation** | 40+ options. Free-tier translations show live verse text; others show reference only |

Verse text is fetched live from [bible-api.com](https://bible-api.com) (public domain
translations) or api.bible (premium translations). Results are cached for the session.

### Speaker / Lower Third

| Field | Notes |
|---|---|
| **Name** | Displayed large on the primary line |
| **Title / Role** | Optional — displayed smaller on the secondary line |

### News Ticker

| Field | Notes |
|---|---|
| **Message** | Scrolling text |
| **Badge label** | Left-side label (default: `⚠ ALERT`) |
| **Speed** | Slow (80 px/s) · Normal (140 px/s) · Fast (220 px/s) · Very Fast (320 px/s) |
| **Style preset** | Alert (red) · Info (blue) · Warning (amber) · Dark · Custom |
| **Position** | Bottom · Top |

---

## Settings Reference

| Setting | Options |
|---|---|
| **Chroma Key Background** | Blue `#0000FF` · Green `#00B140` · Magenta `#FF00FF` · Custom · Transparent |
| **Animation** | Fade · Slide Up · None (instant) |
| **Lower Third Style** | Classic · Accent Line · Minimal · Outline · Gradient Fade · Solid · Split Lines · Frosted Glass |
| **Accent Color** | Colour picker — default gold `#C8A951` |
| **Position** | Lower Third · Upper Third · Centered |
| **Text Alignment** | Left · Center · Right |
| **Font** | 15 options across Display, Elegant Serif, Modern Sans, and System categories |
| **Output Resolution** | 1920 × 1080 (Full HD) · 1280 × 720 (HD) · 3840 × 2160 (4K UHD) |
| **Lower Third BG Image** | Upload image · Fit (Cover / Contain / Stretch) · Focus (Top / Center / Bottom) · Min height |
| **Logo** | Upload PNG/SVG · Position (Left / Right) · Size (40–240 px) |
| **Session Watermark** | Shows session ID in the top-right corner of the output window |
| **Custom Template** | Enable HTML + CSS editor with 5 built-in examples |
| **Browser Source Setup** | Displays the output URL for your current session with a copy button |

All settings are saved to `localStorage` and restored automatically on next open.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` | CUT TO AIR (show overlay) |
| `Esc` | CLEAR (hide overlay) |
| `B` | Switch to Bible Reference mode |
| `S` | Switch to Speaker mode |
| `T` | Switch to Ticker mode |
| `O` | Open / focus Output Window |

Shortcuts are disabled while an input field has focus (except `Enter` in the verse,
speaker name, and title fields which also triggers CUT TO AIR).

---

## Presets

Save and recall frequently used references or ticker messages.

- **Save** — click the bookmark icon next to CUT TO AIR; an auto-generated name is suggested.
- **Load** — click any preset chip to restore all fields.
- **Delete** — click the × on any preset chip.
- **Export** — download all presets as `overlay-presets.json` for backup or sharing.
- **Import** — merge presets from a JSON file (duplicate IDs are skipped).

Presets are stored in `localStorage` and shared across all sessions on the same browser.

---

## Custom HTML Templates

Enable **Settings → Custom Template** to replace the built-in lower-third with your
own HTML and CSS. Five built-in examples are included as starting points.

### Template variables

| Variable | Value |
|---|---|
| `{{line1}}` | Primary text (e.g. `Revelation 3:19` or speaker name) |
| `{{line2}}` | Secondary text (translation, title, or verse text) |
| `{{accentColor}}` | Current accent colour hex value |
| `{{font}}` | Current font-family string |
| `{{logoUrl}}` | Logo image data URL (empty string if no logo) |
| `{{bgUrl}}` | Background image data URL (empty string if no image) |

---

## File Structure

```
reference-overlay/
├── index.html          Control panel (operator view)
├── output.html         Chroma-key / transparent output window
├── server.js           WebSocket + HTTP relay server
├── package.json        Node.js dependency manifest
├── css/
│   ├── control.css     Control panel styles
│   └── output.css      Output window styles
├── js/
│   ├── control.js      Control panel logic
│   ├── output.js       Output window logic
│   └── data.js         Bible books, verse counts, translations, fonts
└── assets/
    └── brand/          Logos and icons
```

---

## Browser Compatibility

| Browser | Local files (`file://`) | Via server (`http://`) |
|---|---|---|
| Chrome 74+ | Full support | Full support |
| Edge 79+ | Full support | Full support |
| Firefox 79+ | May block `window.open` | Full support |
| Safari 15.4+ | May block `window.open` | Full support |

For local file use, Chrome or Edge is recommended.

---

## Adding Custom Bible Translations

Edit `js/data.js` and add an entry to the `TRANSLATIONS` array:

```js
{ abbr: 'MY-VER', name: 'My Translation Name' },
```

Translations listed under **Reference Only** in the UI will not attempt a verse lookup.
To enable verse lookup for a custom translation, verify it is supported by
[bible-api.com](https://bible-api.com) or [api.bible](https://api.bible) and add the
correct tier marker.
