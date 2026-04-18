# Brainbow Foundation — Design Spec

**Date:** 2026-04-18
**Author:** brainstorming session, agentic-work
**Status:** draft, awaiting user review

---

## 0. Why this spec exists

GhostPilot has been a successful local tool — "tell an AI coding agent to use GhostPilot to X" is a daily-use workflow. Three things now demand a reset:

1. **Playwright MCP is consolidating the ecosystem.** v0.0.70 added `get_visible_html`, 143 device emulations, on-demand video, and Playwright v1.59 added `browser.bind()` and `page.screencast` "annotated video receipts." Microsoft also shipped `@playwright/cli` claiming 4× lower token use vs MCP. We need to stop being a niche REST app and become MCP-native to stay relevant.
2. **The recording side is the real differentiator.** Playwright-flavored tools all do *playback recording* (raw video). Brainbow's job is *cinematic recordings* — declarative tape scripts, zoom regions, captions, mouse rings, post-hoc edits — the kind of GIF that ships with a release announcement, not a debugging trace.
3. **Multi-platform consumption.** The same engine should be invokable as a Claude Code skill, an OpenClaw skill, a native agenticode tool, and a hosted MCP service inside the agentic platform — without rewriting the integration N times.

This is also a rename: **GhostPilot → Brainbow** (named after a song by the user's band; ties into the Gnomus.ai brand alongside Synth).

---

## 1. Hard invariants

These are non-negotiable. Every change must preserve all of them.

| # | Invariant | Why |
|---|---|---|
| I1 | **A vision-capable model can see the current screen at any moment via one tool call.** Returns an image content block in the tool response. | The killer use case. Without this, Brainbow is just headless automation. |
| I2 | **A human can see the live browser in real time.** WebSocket viewer streams CDP frames at ~30fps. Works on localhost and through k8s ingress. | The "shared browser" promise. The agent and the human watch the same pixels. |
| I3 | **Every API call is keyed by `sessionId`.** Local mode auto-uses `"default"`; cloud mode requires the caller's session id. | Multi-session is designed in from day one. Adding it later means a rewrite. |
| I4 | **The tape is the source of truth for any recording.** A recording produces a tape; an edit mutates a tape; a render replays a tape. No "render-only" output. | Tapes are diffable, replayable, LLM-editable. Renders are derivative. |
| I5 | **Tool calls never leak secrets.** Bearer tokens, password fields, OAuth params, and JWTs are redacted in logs and broadcast frames before they ever leave the process. | Inherited from GhostPilot v2; tightened on rename. |

---

## 2. Architecture

### 2.1 Components

```
┌──────────────────────────── Brainbow process ─────────────────────────────┐
│                                                                            │
│   ┌────────────┐    ┌─────────────┐    ┌────────────┐   ┌──────────────┐  │
│   │  Express   │    │  MCP server │    │ WebSocket  │   │  Tape engine │  │
│   │  REST API  │    │ (stdio+SSE) │    │  /ws/:sid  │   │ parser+runner│  │
│   └─────┬──────┘    └──────┬──────┘    └─────┬──────┘   └──────┬───────┘  │
│         │                  │                 │                 │          │
│         └──────────────────┴─────┬───────────┴─────────────────┘          │
│                                  │                                        │
│                    ┌─────────────▼─────────────┐                          │
│                    │   Session Manager          │                         │
│                    │   Map<sessionId, Session>  │                         │
│                    └─────────────┬─────────────┘                          │
│                                  │                                        │
│                    ┌─────────────▼─────────────┐                          │
│                    │   Session                  │                         │
│                    │   ├─ Browser (puppeteer)   │                         │
│                    │   ├─ CDP screencast        │                         │
│                    │   ├─ Frame buffer          │                         │
│                    │   ├─ Tape recorder         │                         │
│                    │   ├─ Vision agent (Ollama) │                         │
│                    │   └─ HITL queue            │                         │
│                    └─────────────┬─────────────┘                          │
│                                  │                                        │
│                    ┌─────────────▼─────────────┐                          │
│                    │   ffmpeg encoder          │                          │
│                    │   gif / mp4 / webm        │                          │
│                    └────────────────────────────┘                         │
└────────────────────────────────────────────────────────────────────────────┘
       ▲                ▲                  ▲                       ▲
       │ REST           │ MCP              │ WebSocket             │ stdin/stdout
       │                │ stdio            │ frames + input        │ (.tape files)
       │                │ or SSE           │                       │
   ┌───┴────┐      ┌────┴────┐         ┌───┴────┐             ┌────┴────┐
   │ legacy │      │ Claude  │         │ Viewer │             │  CLI    │
   │ scripts│      │ Code,   │         │ HTML   │             │ brainbow│
   └────────┘      │ Cursor, │         └────────┘             └─────────┘
                   │ agentic.│
                   └─────────┘
```

### 2.2 Boundaries

- **Session Manager** owns the `Map<sessionId, Session>`. It's the only thing that creates or destroys sessions. Local mode auto-creates `sessionId="default"` on first contact. Cloud mode rejects requests for unknown session ids.
- **Session** owns one browser, one CDP session, one frame buffer (last N frames), one tape recorder, one vision agent client, one HITL queue. Sessions are independent — destroying one doesn't affect others.
- **Tape engine** is pure: parse a `.tape` file → AST → execute against a `Session` (drives the browser, captures frames into a tape) → render via ffmpeg. The engine has zero direct browser knowledge; it dispatches verbs to the Session via a small interface.
- **MCP server** and **Express REST** are *transport adapters*. They translate inbound calls into Session method calls. Either can be omitted at deploy time (e.g. CLI-only mode = no Express).
- **WebSocket** is the live frame multiplexer. One WebSocket connection per session viewer. The frame buffer publishes deltas to all subscribers of that session.
- **ffmpeg encoder** runs as a child process per render job. Crashes don't take down the parent.

### 2.3 Process model

- **Local dev (default):** one `node server.js` process, one default session, REST + MCP-stdio + WebSocket all running. Same UX as today.
- **CI / scripted:** `brainbow run <tape>` — no Express, no WebSocket, no UI. Just parse → execute → render → exit.
- **Cloud (k8s):** N pods behind ingress. Each pod hosts M sessions (configurable, default 4). Ingress routes `/s/:sessionId/*` and `/ws/:sessionId` to the pod owning that session. Session-to-pod stickiness via a small router service or via consistent hashing. (Detailed cloud topology out of scope for v1 — v1 ships local + CI; cloud is v2 once the local story is rock-solid.)

---

## 3. The tape DSL

The tape is a text file the LLM authors, edits, and renders. Grammar borrows from charmbracelet/vhs — line-based, no significant whitespace, double-quoted strings.

### 3.1 v1 verb set

```tape
# Output + format ---------------------------------------------
Output           "demo.gif"
Set Format        gif | mp4 | webm
Set FPS           30
Set Quality       high | medium | low
Set Viewport      1440 x 900

# Navigation --------------------------------------------------
Goto             "https://example.com"
Reload
Back
Forward

# Input -------------------------------------------------------
Click            "Sign In"               # by visible text
Click@           "button.submit"         # by CSS selector
Type             "hello@example.com"
Key              Enter
Scroll           dy=400
Hover@           ".tooltip-trigger"

# Wait --------------------------------------------------------
Sleep            500ms                   # absolute pause
Wait@            "h1"                    # for selector
WaitFor          "Welcome back"          # for text on page

# Camera ------------------------------------------------------
Zoom             200,300 400x300         # crop region for output
Pan              200,300                 # move zoom origin
Reset                                    # cancel zoom
Hide                                     # exclude following frames from output

# Annotations -------------------------------------------------
Caption          "Login flow"  duration=2s  position=bottom
Arrow            from=300,400 to=500,600  color=red  duration=1s
Highlight@       ".success-toast"  color=green  duration=2s
MouseRing        on | off

# Flow --------------------------------------------------------
Sub LoginAs(email) {
  Click@         "input[name=email]"
  Type           $email
  Click          "Continue"
}
Var $admin = "admin@example.com"
LoginAs($admin)

If@ ".error" {
  Caption "Error encountered" duration=1s
}

# HITL + Vision ----------------------------------------------
Ask              "Enter MFA code" -> $code
Type             $code
Describe         -> $screen
If $screen contains "dashboard" {
  Caption "Logged in!" duration=1s
}
```

**v2 verbs (deferred):** `Effect ScanLines | VHS | Vignette | Grain` (retro filters), advanced compositing, audio overlay.

### 3.2 Authoring vs running

- A tape can be authored from scratch (LLM writes one).
- A tape can be *recorded* — when `record start` is called, every action the agent takes is appended to a tape buffer; on `record stop`, the tape is written to disk alongside the rendered file.
- An edit is a tape mutation: `tape edit demo.tape "insert Caption \"Done\" at 12s"`. The render is then re-run from the mutated tape.

### 3.3 Tape lifecycle

```
   author / record  →  .tape file  →  parse → AST  →  execute  →  frame stream
                          ▲                                            │
                          │                                            ▼
                          │                                       ffmpeg encode
                          │                                            │
                          │←────────── edit mutates tape ←─────────────┘
```

The `.tape` file and the rendered `.gif` (or `.mp4` etc.) are siblings on disk; either can be regenerated from the other (tape → render is deterministic; render → tape is not).

---

## 4. MCP server

### 4.1 Tool surface

The MCP server exposes one tool group, `brainbow.*`, with these tools:

| Tool | Inputs | Returns |
|---|---|---|
| `screen` | `sessionId?` | text (URL/title/DOM summary) **+ image** (current frame) |
| `launch` | `url`, `sessionId?`, `width?`, `height?` | session info |
| `goto` / `reload` / `back` / `forward` | `url?`, `sessionId?` | page info |
| `click` / `type` / `key` / `scroll` / `hover` | as today, plus `sessionId?` | ok / details |
| `wait` / `wait_for` / `find` | as today | match info |
| `eval` | `script`, `sessionId?` | result |
| `tape_run` | `tape: string` (DSL text) **or** `path: string` | render path + tape path |
| `tape_record_start` | `sessionId?`, `output?: string` | recording id |
| `tape_record_stop` | `sessionId?`, `format?`, `quality?` | render path + tape path |
| `tape_edit` | `path`, `operations: string[]` | new tape path |
| `tape_render` | `path`, `format?`, `quality?` | render path |
| `describe` | `sessionId?`, `prompt?` | text description (Ollama vision) |
| `ask` | `prompt`, `sessionId?`, `timeout?` | user response (HITL) |
| `close` | `sessionId?` | ok |
| `sessions` | — | list of active session ids |

`screen` always returns an image — that satisfies invariant I1.

### 4.2 Transports

- **stdio:** for editor MCP clients (Claude Code, Cursor, Cline, Windsurf). Spawned by the client. Trusts the local OS — no auth.
- **SSE / streamable-HTTP:** for the agentic platform and remote agents. Bearer token via `BRAINBOW_TOKEN` env var. Sessions are scoped per token in cloud mode.

### 4.3 Naming

MCP server name: `brainbow`. Tool prefix in clients: `mcp__brainbow__<tool>`.

---

## 5. REST API

REST stays as today (the live viewer needs it for input forwarding and is not getting rewritten). One change: every endpoint accepts an optional `sessionId` query param or `X-Brainbow-Session` header; when omitted, defaults to `"default"`.

Recordings/scripts/HITL endpoints stay; their semantics now flow through the tape engine internally.

---

## 6. Always-live-visible (Invariant I1)

Implementation details that make I1 enforceable:

- **Frame buffer.** Each Session keeps the last N frames (default N=300, ~10 seconds at 30fps) in memory. The latest frame is always available with O(1) latency.
- **`screen` MCP tool.** Returns a content array `[{type: "text", text: "<DOM summary>"}, {type: "image", source: {type: "base64", media_type: "image/jpeg", data: "..."}}]`. Always. Even if the browser is mid-load, returns the last cached frame and tags it `stale: true`.
- **CI test.** A required test: `launch fixture-page → screen → assert image bytes returned and ≥ 1KB → assert text contains expected DOM content`. If it fails, the build is red. This is the trip-wire that keeps I1 from rotting.

---

## 7. Multi-session (Invariant I3)

Implementation details:

- **`sessionId` parameter** on every API/MCP/WebSocket entry point. Defaults to `"default"` when absent.
- **`SessionManager.get(sessionId)`** lazily creates the session if missing in local mode; rejects in cloud mode unless the caller's auth context owns that sessionId.
- **WebSocket path becomes `/ws/:sessionId`.** The viewer HTML asks the server for its sessionId at boot (via `/api/whoami`) and connects to the right path.
- **Recording state, HITL queue, vision cache, frame buffer** all move from module globals into the Session object.

In local mode, none of this is visible to the user — `default` is implicit. The cost is plumbing through one parameter; the benefit is no rewrite when cloud arrives.

---

## 8. Integrations

All four are pointers to the same engine, not separate implementations.

### 8.1 OpenClaw skill — `integrations/openclaw/brainbow/SKILL.md`

Frontmatter follows the synth pattern (per the existing CLAUDE.md runbook):

```yaml
---
name: brainbow
description: "Drive a real Chromium browser from natural language for local dev, debugging, screenshots, GIF/MP4 recordings with cinematic effects (zoom, captions, mouse highlights), and shared human+AI live browsing. Use when the user wants to record a flow, generate a demo GIF, or have an agent verify a UI change live."
homepage: https://github.com/agentic-work/brainbow
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "emoji": "🌈",
        "requires":
          {
            "bins": ["brainbow"],
            "env": ["BRAINBOW_TOKEN"]
          },
        "primaryEnv": "BRAINBOW_TOKEN"
      }
  }
---
```

Body teaches the host agent: how to launch, how to record a tape, how to apply effects, how to ask for HITL, when **not** to use Brainbow (e.g. server-only API testing — use `curl`/`synth`), and the rule "never paste tokens in chat — Brainbow reads `BRAINBOW_TOKEN` from env."

### 8.2 Claude Code / agenticode skill — `integrations/claude-code/brainbow/SKILL.md`

Same body, frontmatter without the OpenClaw nesting:

```yaml
---
name: brainbow
description: "Drive a real Chromium browser from natural language ..."
when_to_use: "User wants to record a flow, generate a demo GIF/MP4, debug a UI, or have an agent verify a change live."
user-invocable: true
allowed-tools: [Bash]
---
```

Symlink installation (per CLAUDE.md): `ln -s "$(pwd)/integrations/claude-code/brainbow" ~/.claude/skills/brainbow`.

### 8.3 agenticode native tool — `agenticode/src/tools/BrainbowTool/`

- **Rename** `GhostPilotTool` → `BrainbowTool` in `agenticode/src/tools/`. Keep `GhostPilotTool` as a re-export alias for one minor release so existing prompts don't error.
- **Extend** the action enum to include `tape_record_start`, `tape_record_stop`, `tape_run`, `tape_edit`, `describe`, `ask`. The new actions proxy through to `/api/tape/*` (REST) or to the local MCP server when bound.
- **Update** the description prose to mention recording capability. Update the `IMPORTANT` line that today says "GhostPilot replaces all of them" → "Brainbow replaces all of them."
- **Default URL** `process.env.BRAINBOW_URL || process.env.GHOSTPILOT_URL || 'http://localhost:4444'` — backwards-compat env var honored.

### 8.4 agentic platform service — `agentic/services/mcps/awp-brainbow-mcp/`

A small wrapper service that:

- Speaks MCP (SSE) to the agenticwork API
- Forwards calls to a Brainbow pod (or pool of pods)
- Translates platform auth (AgenticWork API key) → `BRAINBOW_TOKEN`
- Mirrors Brainbow's tool surface

Pattern: matches `awp-web-mcp` (Python FastAPI/FastMCP). Keeps Brainbow itself transport-agnostic.

---

## 9. Auth model

| Mode | Caller | Auth |
|---|---|---|
| Local stdio MCP | editor on same machine | none — trusts OS user |
| Local REST | localhost dev tools | none if `BRAINBOW_TOKEN` unset; bearer if set |
| Local WebSocket viewer | browser on same machine | none if `BRAINBOW_TOKEN` unset; bearer in URL or cookie if set |
| Remote SSE MCP | cloud agent | bearer `BRAINBOW_TOKEN` |
| Remote REST | cloud caller | bearer `BRAINBOW_TOKEN` |
| K8s ingress | end user | AgenticWork API key → translated by `awp-brainbow-mcp` to `BRAINBOW_TOKEN` |

Tokens never appear in tape files, log lines, or broadcast WebSocket frames — covered by the existing `redactSecrets` regex set.

---

## 10. Error handling

- **Browser crashes** → Session marked unhealthy, viewer notified, agent gets `{ok:false, error:"browser_crashed", action:"relaunch"}`. SessionManager auto-relaunches on next `launch` call.
- **CDP screencast failures** → fall back to screenshot polling at 7fps (existing behavior). Frame buffer keeps publishing — invariant I2 preserved.
- **ffmpeg missing** → encoding endpoints return `{ok:false, install:"apt-get install ffmpeg"}`. Tape engine returns raw frames dir as a degraded artifact.
- **Vision model missing** → `describe` returns `{ok:false, install:"ollama pull moondream"}`. Tape engine continues; `Describe` verb resolves to empty string.
- **HITL timeout** → tape execution aborts at the `Ask` verb with `{ok:false, error:"hitl_timeout"}`. Partial tape is still saved.
- **Unknown sessionId in cloud mode** → 404 with `{error:"unknown_session"}`. Local mode auto-creates instead.
- **Bearer token mismatch** → 401, no body details (don't leak token-shape info).

---

## 11. Testing

The repo currently has 0% coverage (per the CLAUDE.md runbook, this drags the SonarQube Reliability rating). Plan:

1. **Add `npm test` script** wired to a tiny test harness (`vitest` — already a sibling-project standard).
2. **Coverage target ≥70%** for both lines and branches.
3. **Per-feature tests:**
   - Unit: tape parser (each verb), session manager (lifecycle), encoder (format selection), redaction regexes.
   - Integration: REST endpoints (using a mock browser), MCP tool dispatch (using `@modelcontextprotocol/sdk` test utilities).
   - End-to-end: launch real Chromium against a fixture HTML, record a tape, render to GIF, assert file size > 0 and frame count > 5. **This is the I1 + I2 trip-wire test.**
4. **CI:** `npm run test:coverage` runs in `.github/workflows/sonar.yml` before the SQ scan, producing `coverage/lcov.info` (per the runbook recipe).
5. **Excluded from coverage** (per runbook bug #3): `ui.html` (no logic), `scripts/azure-ad-login.json` (data file).

---

## 12. Migration from GhostPilot

1. Repo done: `agentic-work/brainbow` (private) created, history preserved.
2. Old `agentic-work/ghostpilot` repo: archived with a README redirect ("This project moved to brainbow").
3. Code rename (in this repo):
   - `package.json`: name `@gnomus/brainbow` (or `@agentic-work/brainbow`), description, repo, homepage updated.
   - Env vars: `GHOST_*` → `BRAINBOW_*`. Old names honored with a deprecation warning for one minor release.
   - Default port stays 4444.
   - Console banner, README, server.js comments updated.
4. agenticode rename: `GhostPilotTool` → `BrainbowTool` with one-release alias.
5. Skill files written: `integrations/{openclaw,claude-code}/brainbow/SKILL.md`.
6. agentic service: `services/mcps/awp-brainbow-mcp/` scaffolded.
7. CI: ARC runner set renamed `arc-ghostpilot` → `arc-brainbow` (per runbook helm command). SonarQube project key updated. Secrets `SONAR_TOKEN`, `BRAINBOW_TOKEN` set on the new repo.

---

## 13. Out of scope (v1)

- Retro FX (`ScanLines`, `VHS`, `Grain`, `Vignette`) — v2.
- Audio overlay on recordings — v2.
- Cloud k8s deployment topology (router service, session stickiness, autoscaling) — v2. v1 ships the **interfaces** that make v2 possible without a rewrite.
- Replacing the legacy `scripts/*.json` macros — they keep working as a lower-level concept; tapes are the new public surface.
- Mobile device emulation (Playwright's 143-device set) — v2.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| Tape DSL syntax errors from LLMs | Ship a strict parser with helpful error messages; expose a `tape lint <file>` command; the MCP `tape_run` tool returns parse errors as actionable text. |
| MCP image content blocks too large for some clients | `screen` tool returns max 300KB JPEG (existing logic); auto-shrink at quality 60→25→15→ffmpeg downscale (already implemented). |
| Multi-session memory pressure | Per-session frame buffer capped at N frames (default 300); session idle timeout closes the browser after 10min of no activity. |
| Vision model not installed | `describe` degrades gracefully with install hint; not a hard dependency. |
| Existing GhostPilot users break on rename | One-release env-var aliases (`GHOST_*` honored); agenticode `GhostPilotTool` re-export; old REST endpoints stay as-is. |

---

## 15. Acceptance criteria for v1

A v1 release is ready when **all** of these pass:

1. `node server.js` starts; `curl http://localhost:4444/api/launch` opens Chromium.
2. MCP stdio works in Claude Code: `mcp__brainbow__screen` returns text + image content.
3. `brainbow run examples/demo.tape` produces a `demo.gif` ≥ 50KB with the recorded flow visible.
4. `tape_record_start → click/type → tape_record_stop` produces a sibling `.tape` file alongside the rendered output.
5. The I1 trip-wire test passes (vision model can describe the screen on demand).
6. The I2 trip-wire test passes (WebSocket viewer receives a frame within 100ms of `launch`).
7. SonarQube shows ≥70% coverage and Reliability A.
8. OpenClaw skill installs and triggers (`openclaw skills list` shows brainbow).
9. Claude Code skill installs and `/brainbow` appears in the slash-command menu.
10. agenticode `BrainbowTool` (and `GhostPilotTool` alias) both resolve to the same code path.

---

## 16. Open questions for user review

- **Org choice:** publish npm package as `@gnomus/brainbow` or `@agentic-work/brainbow`? Default assumption: `@agentic-work/brainbow` to match existing repo namespace, can switch later.
- **License header replacement:** the CI changes in the working tree remove `.licenserc.yaml` and the license-check workflow. Confirm we're dropping that proprietary-headers convention — assumed yes since it's already in `git status`.
- **Cloud deployment depth:** v1 ships local + CI only; cloud topology is v2. Is that the right cut, or do you want at least a "single-pod, single-tenant cloud" path in v1?
