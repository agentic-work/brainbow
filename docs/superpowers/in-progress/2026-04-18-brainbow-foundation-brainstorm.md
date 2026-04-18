# Brainbow Foundation — Brainstorm State (in-progress)

**Status:** Brainstorming, not yet a spec. Pick this up when resuming the conversation.
**Started:** 2026-04-18
**Source conversation cwd:** `~/agenticwork/ghostpilot/` (pre-rename), continuing in `~/agenticwork/brainbow/`

---

## Context (one paragraph)

Brainbow is the rename of GhostPilot — a music-themed name (after a song from the user's band) that fits the Synth/Gnomus.ai family. The user wants to "wake the project back up and do it RIGHT" because the codebase is small enough for foundational design without rewrites later. The killer use case is local dev: "tell an AI coding agent to use Brainbow to X" — agent drives a real Chromium, human watches live, both can interject. Must also work as a skill on every major agent host (Claude Code, OpenClaw, Cursor, agenticode, agenticwork SaaS).

## Decisions locked

| # | Decision | Why |
|---|---|---|
| 1 | **Tape format = Charmbracelet `.tape`-style DSL** (not JSON or YAML) | Matches "VHS tape" mental model, reads cleanly, what people associate with declarative recording. JSON intermediate fine internally. |
| 2 | **Tape is the source of truth** for record / edit / effect / render. Effects mutate the tape. Edits are tape rewrites. Recording emits a tape as it goes. | One mental model for the LLM instead of three separate APIs. Tapes are diffable, replayable, shareable. |
| 3 | **MCP-native + REST**. MCP server (stdio + SSE) is primary interface for agents. REST API stays for the live viewer's own UI and as an escape hatch. | "Skill by any agent" basically forces MCP. Microsoft's `@playwright/cli` + Playwright v1.59 `browser.bind()`/`page.screencast` confirm this is where the ecosystem went. |
| 4 | **Always-live-visible invariant** — a vision-capable model can see the current Brainbow screen at any moment with one tool call, returning an MCP image content block. CI must validate this with a `launch → screen → vision-describe` test on every build. | Hard requirement from the user. Vision-by-default, never stale by more than ~33ms (one CDP frame at 30fps). |
| 5 | **sessionId-everywhere from day one**, even though local mode ships first. Local auto-uses `sessionId="default"`. WebSocket is `/ws/{sessionId}`. Browser/page/recording state keyed by session. K8s ingress routes by sessionId. | The k8s SaaS path requires per-user live browser viewing; designing this in now avoids a rewrite later. |
| 6 | **Project name: Brainbow.** Repo `agentic-work/brainbow` (private). Old `ghostpilot` dir archived in place. Env vars `GHOST_*` → `BRAINBOW_*`. Tool/MCP/skill name everywhere is `brainbow`. agenticode `GhostPilotTool` → `BrainbowTool` (alias for one release). | User picked the name — band song, sister to Synth, fits Gnomus.ai. |
| 7 | **Tape DSL v1 verbs include control flow** (`Sub`, `If`, `Var`) and **vision** (`Describe -> $var`) and **HITL** (`Ask "..." -> $var`) — not deferred to v2. Retro FX (`ScanLines`, `VHS`, `Grain`) also v1. | "No rush, do it right." |
| 8 | **Scope: 4 specs, 1 brainstorm.** This brainstorm covers Spec 1 (Brainbow Core). Specs 2/3/4 are short follow-ons once Core's API is locked. | Keeps each spec scoped to one implementation cycle. |

## v1 tape verbs (proposed; locked unless user changes)

```
# Navigation
Goto <url>
Reload
Back
Forward

# Input
Click <selector | text>
Type "..."
Key <Enter|Tab|Escape|...>
Scroll <dy>
Hover <selector>

# Wait
Sleep <duration>
Wait <selector>
WaitFor "<text>"

# Recording / output
Output <file>
Set Format gif|mp4|webm
Set FPS <n>
Set Quality high|medium|low
Set Width <px>
Set Height <px>

# Camera
Zoom <x>,<y> <w>x<h> [over <duration>]
Pan <x>,<y> [over <duration>]
Reset
Hide                  # exclude frames from output

# Annotations
Caption "..." [for <duration>] [at <x>,<y>]
Arrow <x>,<y> -> <x>,<y> [for <duration>]
Highlight <selector> [for <duration>]
MouseRing on|off

# Retro FX
Effect ScanLines on|off
Effect VHS on|off
Effect Grain on|off
Effect Vignette on|off

# Control flow
Sub <name> { ... }       # define reusable block
Run <name>               # invoke a Sub
Var $name = "..."
If <selector exists> { ... } [else { ... }]

# HITL & vision
Ask "<prompt>" -> $var
Describe [-> $var]
```

## Specs to write (after this brainstorm closes)

1. **`2026-04-18-brainbow-core-design.md`** — server.js refactor for sessionId, MCP server, tape engine, recording effects pipeline, viewer UI updates, mouse-cursor rendering, tests + Sonar coverage fix. *This is the one we're brainstorming now.*
2. **`2026-04-XX-brainbow-skills-packaging-design.md`** — `integrations/openclaw/brainbow/SKILL.md` and `integrations/claude-code/brainbow/SKILL.md`. Mostly templated from synth's pattern. ~Half a page each.
3. **`2026-04-XX-brainbow-agenticode-tool-design.md`** — extend `agenticode/src/tools/GhostPilotTool/` → `BrainbowTool/`. Add tape/record/effect/edit/HITL/vision actions. Compatibility alias for one release.
4. **`2026-04-XX-brainbow-agentic-mcp-service-design.md`** — new `agentic/services/mcps/awp-brainbow-mcp/` (Python FastAPI/MCP wrapper around Brainbow REST/MCP, runs in k3s, ingress per-session).

## Open questions (in priority order — pick up here)

1. **Mouse cursor rendering in recordings.** Headless Chromium has no real cursor. Options:
   - (a) Always overlay a synthetic cursor in encoded recordings (post-process via ffmpeg `drawbox`/`overlay`).
   - (b) Only when `MouseRing on` (default off → no cursor visible, matches some cleaner aesthetics).
   - (c) Always overlay in the live screencast too, so the human viewer sees what the agent is "pointing at".
   - Recommendation: **(c)** — synthetic cursor overlay both in live viewer and recordings, controllable via `MouseRing off` to hide. The whole point is human + agent watching the same thing.

2. **Vision agent (Ollama moondream/llava).** Currently built-in. Options:
   - (a) Keep built-in default (current).
   - (b) Make it optional — only loads if `BRAINBOW_VISION=ollama` env set.
   - (c) Drop it; rely entirely on the host agent's own vision via MCP image blocks.
   - Recommendation: **(b)** — optional plugin, default off. Saves the Ollama dependency for users who don't need watch-mode descriptions; the always-live-visible invariant is satisfied by MCP image blocks regardless.

3. **Existing scripts engine + JSON macros.** Options:
   - (a) Migrate to tape format (one runner, two file extensions: `.tape` for new, auto-convert old `.json`).
   - (b) Keep both, scripts as a "low-level" concept.
   - (c) Deprecate + remove.
   - Recommendation: **(a)** — single runner, auto-convert old JSON to tape on read.

4. **Tests + Sonar coverage strategy.** CLAUDE.md runbook flags 0% coverage as an existing problem. Options:
   - (a) Fix in this revival (add Vitest + integration tests for tape engine, MCP server, sessionId routing).
   - (b) Defer to a follow-on.
   - Recommendation: **(a)** — adding tests for the new tape engine + MCP server will lift coverage substantially anyway, and it lets us validate the always-live-visible invariant in CI.

5. **Backward compat / migration path.** Codebase is small, no known external users beyond the agenticode tool that's already pinned to `GhostPilotTool`. Options:
   - (a) Clean slate — new package name `@agentic-work/brainbow`, deprecate old.
   - (b) Provide a one-release transition: ship `@agentic-work/ghostpilot` as a re-export shim of `brainbow`.
   - Recommendation: **(b)** — cheap, courteous, gives the agenticode tool a clean upgrade path.

## Recommended next step when conversation resumes

Pick answers for the 5 open questions above (or accept the recommendations), then move to **proposing 2-3 architectural approaches** for the Brainbow core spec — likely:

- **Approach A** — minimal refactor of the existing single-file `server.js` to add sessionId + MCP transport.
- **Approach B** — modular split into `src/{browser,recording,tape,mcp,viewer}/` modules; sessionId via dependency injection.
- **Approach C** — split server (browser host) and renderer (tape→video pipeline) into separate processes communicating over a queue, so encoding doesn't block the live viewer.

After approach selection: design sections (architecture, components, data flow, error handling, testing) presented one at a time for approval, then the spec doc gets written to `docs/superpowers/specs/2026-04-18-brainbow-core-design.md` and committed.

## Quick resume prompt

When resuming in `~/agenticwork/brainbow/`, say something like:

> "Resume the Brainbow brainstorm — read `docs/superpowers/in-progress/2026-04-18-brainbow-foundation-brainstorm.md` and the memories, then pick up at the open questions."
