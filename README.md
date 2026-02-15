# Overlay

A browser-based lower-third overlay controller for live video production.
Displays **Bible references** (book · chapter · verse · translation) or
**speaker names** as a chroma-key overlay for use with ATEM, Wirecast, and OBS.

---

## How It Works

Two browser windows talk to each other in real time:

| Window | File | Purpose |
|---|---|---|
| **Control Panel** | `index.html` | Operator inputs the reference or speaker name |
| **Output Window** | `output.html` | Captured by ATEM / Wirecast / OBS as a chroma-key source |

The Output Window has a solid colour background (blue, green, or magenta).
Your switcher/software removes that colour via chroma key, leaving only the
lower-third graphic floating over your live video.

---

## Quick Start

### Option A — Run Locally (no server needed)

1. Download or clone this repository.
2. Open `index.html` in **Chrome** or **Edge** (recommended for BroadcastChannel support).
3. Click **↗ Output Window** — a second window opens at your chosen resolution.
4. Add the Output Window as a source in your switcher (see below).
5. Select a Bible reference or speaker name and press **SHOW**.

> **Note:** Safari and Firefox support BroadcastChannel but may restrict
> `window.open()` for local files. Chrome/Edge work best.

### Option B — Host on a Web Server / Cloud

Upload all files to any static hosting service:

- **Netlify** — drag the folder to [app.netlify.com/drop](https://app.netlify.com/drop)
- **Vercel** — `vercel deploy`
- **GitHub Pages** — push to a `gh-pages` branch
- **Any local web server** — `npx serve .` or `python3 -m http.server`

Once hosted, open the URL in two tabs/windows — one for Control, one for Output.

---

## Connecting to Your Equipment

### ATEM Mini SDI Extreme ISO / ATEM Production Studio 4K

1. On your **operator machine**, open both windows.
2. Resize the **Output Window** to exactly **1920 × 1080** (Full HD)
   or your programme resolution.
3. In **ATEM Software Control → Upstream Key**:
   - Source: the screen/window capture of the Output Window
   - Key Type: **Luma** or **Chroma**
   - Chroma: match the selected background colour (Blue / Green)
4. Enable the key on the desired M/E bus.

### Wirecast

1. Add a **Window Capture** source pointing to the Output Window.
2. In Shot Layer properties, add a **Chroma Key** filter.
3. Pick colour to match the Output Window background.

### OBS

1. Add a **Window Capture** source (or **Browser Source** if self-hosting).
2. Right-click → **Filters → Add → Chroma Key**.
3. Set Key Colour Type to match the selected background colour.

---

## Controls

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` | Show overlay |
| `Esc` | Clear overlay |
| `B` | Switch to Bible Reference mode |
| `S` | Switch to Speaker mode |
| `O` | Open / focus Output Window |

### Bible Reference Fields

| Field | Notes |
|---|---|
| **Book** | All 66 books, grouped Old / New Testament |
| **Chapter** | Enter a number |
| **Verse** | Starting verse |
| **To Verse** | Optional — creates a verse range (e.g. 3:19–21) |
| **Translation** | 28 common translations included |

### Speaker Fields

| Field | Notes |
|---|---|
| **Speaker Name** | Displayed on the main (large) line |
| **Title / Role** | Optional — displayed on the secondary (small) line |

---

## Settings

| Setting | Options |
|---|---|
| **Chroma Key Background** | Blue `#0000FF` · Green `#00B140` · Magenta `#FF00FF` · Custom |
| **Animation** | Fade · Slide Up · None (instant) |
| **Lower Third Style** | Classic (dark bar) · Accent line · Minimal (text only) · Outlined |
| **Accent Color** | Colour picker — defaults to gold `#C8A951` |
| **Position** | Lower Third · Upper Third · Centered |
| **Font** | System default · Georgia · Arial · Trebuchet MS · Verdana · Times New Roman |
| **Output Resolution** | 1920×1080 (Full HD) · 1280×720 (HD) · 3840×2160 (4K) |

Settings are saved to `localStorage` and restored on next open.

---

## File Structure

```
Overlay/
├── index.html        Control panel (operator view)
├── output.html       Chroma-key output window
├── css/
│   ├── control.css   Control panel styles
│   └── output.css    Output window styles
└── js/
    ├── data.js       Bible books + translations data
    ├── control.js    Control panel logic
    └── output.js     Output window logic
```

---

## Browser Compatibility

| Browser | Local Files | Hosted |
|---|---|---|
| Chrome 74+ | ✅ Full support | ✅ |
| Edge 79+ | ✅ Full support | ✅ |
| Firefox 79+ | ⚠ May block `window.open` for local files | ✅ |
| Safari 15.4+ | ⚠ May block `window.open` for local files | ✅ |

For local (file://) use, Chrome or Edge is strongly recommended.

---

## Adding Custom Translations

Edit `js/data.js` and add an entry to the `TRANSLATIONS` array:

```js
{ abbr: 'MY-VERSION', name: 'My Custom Translation Name' },
```

---

## Roadmap / Planned Features

- [ ] Verse text lookup (Bible API integration)
- [ ] Preset save / recall (quick-access buttons for frequent references)
- [ ] Multiple simultaneous output targets
- [ ] WebSocket server mode for tablet/phone remote control
- [ ] Custom lower-third HTML template editor
