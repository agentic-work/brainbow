<p align="center">
  <img src="ghostpilot_logo.png" alt="GhostPilot" width="500" />
</p>

<p align="center">
  <strong>Shared browser control — human and AI copiloting a real Chromium browser at ~30fps.</strong><br />
  Part of the <a href="https://agenticwork.io">AgenticWork Platform</a>
</p>

<p align="center">
  <a href="https://agenticwork.io/ghostpilot">Website</a> ·
  <a href="https://docs.agenticwork.io/platform/ghostpilot">Docs</a> ·
  <a href="https://agenticwork.io/blog/ghostpilot-shared-browser-ai">Blog Post</a>
</p>

---

[![GhostPilot — Peer with AI to develop UX faster](ghostpilot.png)](https://agenticwork.io/ghostpilot)

> **See it in action:** Watch the [live demo video](https://agenticwork.io/ghostpilot) on our website.

GhostPilot runs a headless Chromium instance and streams it to a web viewer in real time using CDP screencast (~30fps). The human sees and interacts with the browser directly. An AI agent controls it through a REST API. Both operate on the same session simultaneously.

## Quick Start

```bash
npm install
npm start        # starts on http://localhost:4444
```

Open `http://localhost:4444` in your browser. Enter a URL in the sidebar and click **Go**.

Custom port:

```bash
GHOST_PORT=5555 node server.js
```

## How It Works

```
┌─────────────┐     WebSocket (frames + input)     ┌──────────────┐
│   Browser    │◄──────────────────────────────────►│  Web Viewer  │
│  (Chromium)  │     CDP screencast ~30fps          │  (ui.html)   │
│              │                                    │              │
│  Playwright  │◄── REST API ──────────────────────►│  AI Agent    │
│              │    /api/click, /api/type, etc.      │  (Claude)    │
└─────────────┘                                    └──────────────┘
```

- **CDP screencast** streams JPEG frames at near-native speed via Chrome DevTools Protocol
- **Human input** (click, scroll, type) is forwarded through WebSocket to the browser
- **AI input** uses the REST API — same browser, same page, same session
- **Action log** in the sidebar shows everything both parties do in real time

## REST API

All endpoints accept JSON. The browser must be launched first with `POST /api/launch`.

### Browser Lifecycle

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/launch` | `{ url }` | Launch browser, navigate to URL |
| POST | `/api/close` | — | Close browser |
| GET | `/api/page` | — | Current URL, title, viewport |

### Navigation & Interaction

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/goto` | `{ url, waitUntil? }` | Navigate to URL |
| POST | `/api/click` | `{ selector?, text?, x?, y?, button? }` | Click by selector, text, or coordinates |
| POST | `/api/type` | `{ selector?, text, delay?, clear? }` | Type into element or keyboard |
| POST | `/api/key` | `{ key }` | Press a key (e.g. `Enter`, `Tab`, `Escape`) |
| POST | `/api/scroll` | `{ x?, y?, selector? }` | Scroll page or element |
| POST | `/api/select` | `{ selector, value?, label? }` | Select dropdown option |
| POST | `/api/upload` | `{ selector, filePath }` | Upload file to input |
| POST | `/api/dialog` | `{ action?, text? }` | Accept/dismiss next dialog |

### Reading State

| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| POST | `/api/wait` | `{ selector?, text?, state?, timeout? }` | Wait for element |
| POST | `/api/find` | `{ selector?, text? }` | Find elements, return bounding boxes + text |
| POST | `/api/text` | `{ selector }` | Get text content of element |
| POST | `/api/eval` | `{ script }` | Run JavaScript in page context |
| GET | `/api/screenshot` | `?full=true` | PNG screenshot |
| GET | `/api/log` | `?n=50` | Recent action log |

### Example: AI Agent Session

```bash
# Launch browser
curl -X POST http://localhost:4444/api/launch \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com"}'

# Click a link
curl -X POST http://localhost:4444/api/click \
  -H 'Content-Type: application/json' \
  -d '{"text": "More information"}'

# Type into a search box
curl -X POST http://localhost:4444/api/type \
  -H 'Content-Type: application/json' \
  -d '{"selector": "input[type=search]", "text": "hello world"}'

# Press Enter
curl -X POST http://localhost:4444/api/key \
  -H 'Content-Type: application/json' \
  -d '{"key": "Enter"}'

# Get current page info
curl http://localhost:4444/api/page
```

## Web Viewer

The viewer at `http://localhost:4444` provides:

- **Live browser stream** — click, scroll, and type directly in the rendered frame
- **URL bar** — navigate to any page
- **Action log** — real-time feed of all actions (human and AI)
- **Text input** — type text to send keystrokes to the browser
- **Coordinate display** — shows mouse position mapped to actual page coordinates

Human interactions (click, scroll, keyboard) are forwarded to the browser via WebSocket. The viewer maps rendered pixel coordinates to actual page coordinates accounting for `object-fit: contain` scaling.

## Architecture

- **Express** serves the REST API and static UI
- **Playwright** manages the headless Chromium instance
- **CDP (Chrome DevTools Protocol)** provides hardware-accelerated screencast at ~30fps
- **WebSocket** streams frames to viewers and receives human input
- **Fallback**: if CDP screencast fails, falls back to screenshot polling at ~7fps

## Dependencies

- `express` — HTTP server and REST API
- `playwright` — Browser automation (Chromium)
- `ws` — WebSocket server for real-time streaming
- `sharp` — Image processing (available for future use)

## License

MIT
