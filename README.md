<!-- SPDX-License-Identifier: MIT -->

<p align="center">
  <strong>Brainbow — Shared browser control + cinematic recording studio for AI agents.</strong><br />
  Part of <a href="https://gnomus.ai">Gnomus.ai</a>
</p>

---

Brainbow runs a headless Chromium instance and streams it to a web viewer in real time using CDP screencast (~30fps). The human sees and interacts with the browser directly. An AI agent controls it through MCP or REST. Both operate on the same session simultaneously.

What sets Brainbow apart from Playwright MCP and other browser-automation tools:

- **Always live-visible:** any vision-capable model can ask `screen` and get back the current frame as an image content block. The human's WebSocket viewer streams the same frames at ~30fps.
- **Cinematic recordings:** declarative `.tape` scripts (à la charmbracelet/vhs) drive both the browser and the recording. Effects — zoom regions, captions, mouse rings, highlights — are first-class verbs, not post-production.
- **Multi-session ready:** every API call is keyed by `sessionId`. Local mode hides this; cloud mode (k8s) routes per-user via session-id-encoded ingress.
- **Vision agent built in:** Ollama (moondream/llava) runs as a fallback vision provider for hosts without first-class vision.
- **HITL native:** tape verb `Ask` pauses execution, prompts the user via the viewer, fills a variable, resumes.

## Quick Start

```bash
npm install
npm start        # http://localhost:4444
```

Open `http://localhost:4444`, type a URL in the sidebar, click **Go**.

## Status

This is the foundation milestone (`v0.7.0`). The legacy REST API works; the tape DSL, MCP server, effects pipeline, and skill packaging land in subsequent milestones (see `docs/superpowers/plans/`).

## License

MIT — see [LICENSE](LICENSE). Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
