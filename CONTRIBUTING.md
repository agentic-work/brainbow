# Contributing to Brainbow

Brainbow is MIT-licensed. PRs welcome.

## Dev setup

```bash
git clone https://github.com/agentic-work/brainbow.git
cd brainbow
npm install
npm test                    # vitest with coverage
node server.js              # starts on localhost:4444
```

You'll need:
- Node.js 20+
- A Chromium binary on PATH (or set `CHROME_PATH`)
- ffmpeg on PATH (optional — recordings degrade gracefully without it)
- ollama (optional — vision agent uses it for `Describe`)

## Tests

`npm test` runs vitest. We target ≥70% line + branch coverage. Two trip-wire
integration tests are required to pass on every commit:

- `tests/trip-wires/i1-vision.test.js` — proves the screen-content tool
  always returns an image (Invariant I1 in the foundation spec).
- `tests/trip-wires/i2-viewer-frame.test.js` — proves a WebSocket viewer
  receives a frame within 100ms of `launch` (Invariant I2).

If a change breaks either of those, the change is wrong, not the test.

## Commit style

Imperative, type-prefixed:

```
feat(tape): add Zoom verb to the parser

<body explaining why, not what>
```

Types: `feat`, `fix`, `docs`, `test`, `ci`, `refactor`, `chore`. We commit to
`main` directly; PRs only when explicit review is wanted.

## Filing bugs

GitHub Issues. Include `node -p "require('./package.json').version"`, your OS + Node version, and the smallest reproducer that triggers the bug.
