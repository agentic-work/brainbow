<!-- SPDX-License-Identifier: MIT -->

<p align="center">
  <img src="brainbow-icon.png" alt="Brainbow" width="96" /><br />
  <strong>Brainbow — programmable shared browser + live-vision narrator for AI agents.</strong><br />
  An <a href="https://agenticwork.io">Agenticwork</a> project.
</p>

---

Brainbow runs a Chromium instance and streams it to a web viewer in real time using CDP screencast (~30fps). The human sees and interacts with the browser directly. An AI agent controls it through MCP or REST. Both operate on the same session simultaneously.

What sets Brainbow apart from Playwright MCP and other browser-automation tools:

- **Always live-visible:** any vision-capable model can ask `screen` and get back the current frame as an image content block. The human's WebSocket viewer streams the same frames at ~30fps.
- **Live-vision narrator built in:** a vision model (default: local Ollama `qwen2.5vl:7b`) narrates the live session continuously; `bedrock`, `anthropic`, and `openai` providers are also supported.
- **Cinematic recordings:** drive the page normally while recording, then encode to mp4/webm/gif with optional zoom crops.
- **Multi-session ready:** every API call is keyed by `sessionId`. Local mode hides this; cloud mode (k8s) routes per-user via session-id-encoded ingress.
- **Log tailing:** subscribe to `kubectl logs -f` / `docker logs -f` and fold their output into the same `live` observation stream.

## Quick Start (REST + viewer)

```bash
npm install
npm start        # http://localhost:4444
```

Open `http://localhost:4444`, type a URL in the sidebar, click **Go**.

## MCP server

Brainbow ships a stdio MCP server exposing 27 browser/vision/recording tools. The MCP process adopts-or-spawns a shared REST server on `:4444` and owns its lifecycle (it dies when the MCP host disconnects — no zombie REST).

Add one of the following to your `claude_desktop_config.json` (or any MCP host config):

```json
{
  "mcpServers": {
    "brainbow": {
      "command": "node",
      "args": ["src/mcp-server.js"],
      "env": {
        "BRAINBOW_VISION_PROVIDER": "ollama",
        "BRAINBOW_OLLAMA_HOST": "http://localhost:11434"
      }
    }
  }
}
```

Or run it straight from npm without cloning:

```json
{
  "mcpServers": {
    "brainbow": {
      "command": "npx",
      "args": ["-y", "@agenticwork/brainbow"],
      "env": {
        "BRAINBOW_VISION_PROVIDER": "ollama",
        "BRAINBOW_OLLAMA_HOST": "http://localhost:11434"
      }
    }
  }
}
```

### Tools (27)

| Tool | What it does |
|---|---|
| `screen` | Capture the current browser frame as an image plus DOM counts + the latest narration line. |
| `live` | Keystone observation: one call returns the latest frame, narration deltas, DOM snapshot, page console, and external log-tail lines (pass `cursor` for deltas). |
| `launch` | Open a Chromium browser for the session (optional URL + viewport size). |
| `close` | Close the browser for the session (idempotent). |
| `goto` | Navigate the current page to a URL. |
| `click` | Click an element by `{selector}` or `{x, y}`. |
| `type` | Type text into the page (optionally focus a selector first). |
| `key` | Press a single key (Enter, Escape, Tab, ArrowDown, …). |
| `scroll` | Scroll the page by `dy` pixels to reveal below-fold content. |
| `wait_for` | Wait until a selector / text / url predicate is satisfied. |
| `eval` | Run JavaScript in the page context (async, top-level `await`) and return the JSON result. |
| `snapshot` | Return the accessibility-tree snapshot for selector-free targeting. |
| `find` | Find an element by CSS selector or visible text; returns its bounding box. |
| `console` | Return recent browser-side console / pageerror messages. |
| `sessions` | List the brainbow sessions currently active on the server. |
| `narrate_start` | Start continuous vision narration on the session. |
| `narrate_stop` | Stop vision narration. |
| `log_subscribe` | Tail an external command (`kubectl logs -f`, `docker logs -f`, …) into the session (requires `BRAINBOW_LOG_TAILS_ENABLED=true`). |
| `log_unsubscribe` | Stop a previously-started log tail. |
| `log_list` | List all currently-running log tails. |
| `open_viewer` | Open the live viewer for this session in the default browser. |
| `record_start` | Begin recording the live frame stream into a buffer (optional zoom crop). |
| `record_stop` | Stop recording and encode the buffered frames into mp4 / webm / gif. |
| `record_status` | Report recording progress (frames buffered, elapsed, ffmpeg availability). |
| `recordings_list` | List the encoded recordings saved on the server. |
| `restart_rest` | Restart the shared brainbow REST server (the managed child of this MCP). |
| `vision_model` | Report the active vision narrator provider + model id. |

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `BRAINBOW_URL` | Existing brainbow REST base URL (skips autostart). | `http://localhost:$BRAINBOW_PORT` |
| `BRAINBOW_PORT` | REST port (one shared REST per host). | `4444` |
| `BRAINBOW_SESSION` | Session id (one Chromium window per session). | auto-derived per host process |
| `BRAINBOW_AUTOSTART_REST` | `false` to adopt an externally-managed REST instead of spawning one. | `true` |
| `BRAINBOW_AUTOOPEN_VIEWER` | `true` to auto-open the live viewer on launch (otherwise use the `open_viewer` tool). | `false` |
| `BRAINBOW_VISION_PROVIDER` | Vision narrator provider: `ollama` \| `bedrock` \| `anthropic` \| `openai`. | `ollama` |
| `BRAINBOW_VISION_MODEL` | Vision model id for the chosen provider. | `qwen2.5vl:7b` |
| `BRAINBOW_OLLAMA_HOST` | Ollama base URL (for the `ollama` provider). | `http://localhost:11434` |
| `BRAINBOW_VISION_AUTOSTART` | Start the narrator automatically on first `live` call. | `false` |
| `BRAINBOW_LOG_TAILS_ENABLED` | Enable the `log_subscribe` external-command tails. | `false` |
| `BRAINBOW_RECORDINGS` | Directory for encoded recordings. | `<tmp>/brainbow-recordings` |

## Docker

```bash
docker build -t brainbow:latest .
docker run --rm -p 4444:4444 brainbow:latest
```

The image bundles `puppeteer-core` + system Chromium + ffmpeg, runs as the non-root `node` user, and ships a `/health` HEALTHCHECK.

## License

MIT — see [LICENSE](LICENSE). Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
