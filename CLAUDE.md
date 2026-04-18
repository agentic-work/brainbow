# GhostPilot — Agent Runbook

GhostPilot is a Node.js app that streams a headless Chromium instance to a web viewer at ~30fps while an AI agent controls it via REST. Same as the other `agentic-work` repos, CI runs on the k3s-hosted ARC runner `arc-ghostpilot`, SonarQube is served at `https://sonarqube-dev.agenticwork.io`, and the OpenClaw skill (if any) lives under `integrations/openclaw/`.

The sections below are a **runbook** extracted from the synth repo's end-to-end stabilization work. If CI is queueing, Sonar is showing 0% coverage, or the OpenClaw skill isn't triggering — match the symptom and apply the fix.

---

## When the ARC runner won't dispatch jobs

**Symptoms:** Workflow runs sit in `queued` state for minutes/hours. `kubectl logs -n arc-systems <listener-pod>` shows `"assigned job"=0 min=0 max=0` every poll.

**Root cause (cluster-wide):** the `gha-runner-scale-set` Helm chart defaults `maxRunners: 0`. Listener polls GitHub fine, but the scaler's math refuses to spawn a runner when `max=0`. This affects every runner set (`arc-<repo>`) until patched individually.

**Fix:**

```bash
# Raise maxRunners without nuking other values:
helm upgrade arc-ghostpilot \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set \
  --version 0.14.0 -n arc-runners \
  --reuse-values \
  --set maxRunners=3 \
  --set minRunners=0
```

**Cap sizing:** `maxRunners * 6 sibling runner sets * 1Gi memory request` must fit on whichever node has the `kubernetes.io/arch: amd64` label. In this cluster that's **`hal` (31Gi)** — the `k8*` raspberry pis are ARM64 and cannot schedule the amd64 runner image. Starting at `maxRunners=3` (≤18 cluster-wide) leaves comfortable headroom. Don't set `maxRunners=10` — that provoked a hal OOM when the 2-week backlog flooded in at once.

**Verify:**

```bash
kubectl get autoscalingrunnerset -n arc-runners \
  -o custom-columns=NAME:.metadata.name,MIN:.spec.minRunners,MAX:.spec.maxRunners
```

**If a rename broke it:** when a repo is renamed (e.g. `oat` → `synth`), the old `AutoscalingRunnerSet` CR lingers with `deletionTimestamp` + stuck finalizer. A fresh `helm install arc-<new-name>` pointed at the new URL works; the dead CR is cosmetic (`max: 0`, no listener, harmless).

---

## When SonarQube shows 0.0% coverage despite tests passing

This cost a whole evening on synth. The scan was uploading successfully, quality gate was green-ish, but the coverage column stayed at **0.0%** forever. Three independent bugs compounded.

**Bug 1 — coverage.xml never produced.** The `sonar-project.properties` had `sonar.javascript.lcov.reportPaths` commented out. Solution: run the test suite with coverage before the scan step in `.github/workflows/sonar.yml`, and uncomment the right line in properties. For Node:

```yaml
- run: npm ci
- run: npm run test:coverage    # must produce coverage/lcov.info
```

```properties
sonar.javascript.lcov.reportPaths=coverage/lcov.info
```

For Python (synth): `pytest --cov=<pkg> --cov-report=xml` + `sonar.python.coverage.reportPaths=coverage.xml`.

**Bug 2 — subprocess coverage wasn't traced.** If the tests spawn the CLI as a subprocess (PTY / pexpect / child_process), the coverage tool on the parent doesn't see them. For Python: add a site-packages `.pth` that calls `coverage.process_startup()` and set `COVERAGE_PROCESS_START=.coveragerc`. For Node: pass `NODE_V8_COVERAGE=coverage/tmp` to children and merge with `c8`.

**Bug 3 — dead code dragging the denominator.** Stubs that are unwired (in synth: `identity.py`, `metrics.py`, `mcp/server.py`, `platform/integration.py`) have 0% coverage but still count. Exclude them both from coverage **and** from analysis:

```properties
sonar.exclusions=<paths>,src/stubs/**,src/experimental/**
sonar.coverage.exclusions=<same paths>
```

Exclude from *both* — `sonar.exclusions` removes them from the scan entirely; `sonar.coverage.exclusions` just removes them from the coverage denominator. Put new stubs in *both* lists or the Reliability/Maintainability ratings will count issues they contain.

---

## When SonarQube's scan authenticates with `SONAR_TOKEN: ` empty

**Symptom:** Scan logs show `Failed to query server version: Expected URL scheme 'http' or 'https' but no scheme was found`. Or `SONAR_TOKEN:` and `SONAR_HOST_URL:` appear blank in the job env.

**Root cause:** Secrets are scoped per-repo. After a repo rename (or new repo creation), `SONAR_TOKEN` doesn't carry over. GitHub's secret list (`gh secret list -R agentic-work/<repo>`) will be empty.

**Fix:**

1. Generate a **Global Analysis Token** in SonarQube UI: User avatar → My Account → Security → Generate Tokens (name: `<repo>-ci`, type: **Global Analysis**).
2. Store the value:
   ```bash
   gh secret set SONAR_TOKEN -R agentic-work/ghostpilot -b "sqa_..."
   ```
3. Set the host URL (runners hit it from inside the cluster, no public ingress needed):
   ```bash
   gh variable set SONAR_HOST_URL \
     --body "http://sonarqube-sonarqube.sonarqube.svc:9000" \
     -R agentic-work/ghostpilot
   ```

For the whole org in one shot (needs `admin:org` token scope):
```bash
gh secret set SONAR_TOKEN --org agentic-work --visibility all -b "sqa_..."
```

**Lock down the public ingress** so only your external IP (and the cluster) can hit the SQ UI:

```bash
kubectl annotate ingress -n sonarqube sonarqube-sonarqube \
  nginx.ingress.kubernetes.io/whitelist-source-range="<YOUR_EXT_IP>/32,10.0.0.0/8,192.168.0.0/16" \
  --overwrite
```

GitHub's IPs are **not** needed in the allowlist — ARC runners live inside the cluster and hit SonarQube via the internal service DNS.

---

## When Reliability is C/D and you don't understand why

SonarQube's Reliability rating is driven entirely by **BUGs** (not code smells). Worst-severity bug sets the rating:

| Bugs present | Rating |
|--------------|--------|
| 0 | **A** |
| ≥1 MINOR | B |
| ≥1 MAJOR | C |
| ≥1 CRITICAL | D |
| ≥1 BLOCKER | E |

Query the list:

```bash
curl -s -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/issues/search?componentKeys=ghostpilot&types=BUG&ps=20" \
  | python3 -m json.tool
```

**The usual culprits on Node projects:**
- `S7487` — `child_process.execSync` / `spawnSync` inside an `async` function → wrap in `execa` or `util.promisify(exec)`.
- `S7503` — function declared `async` but never `await`s anything → either drop the `async` or `await new Promise(r => setImmediate(r))` at the top if a Protocol/interface requires it.
- `S7501` — `readline.question()` called synchronously in an async fn → use `readline/promises`.

All three are MAJOR → push Reliability to C. Fix all of them, push, and the next scan drops to A.

**Query the Quality Gate directly** instead of squinting at the dashboard:

```bash
curl -s -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/qualitygates/project_status?projectKey=ghostpilot" \
  | python3 -m json.tool
```

---

## OpenClaw skill integration

If this repo publishes an OpenClaw skill (check `integrations/openclaw/`), the skill file uses YAML frontmatter + a body that the host agent follows. Required metadata in frontmatter:

```yaml
---
name: <skill-name>
description: "<when the host agent should invoke this skill — be specific about keywords and when NOT to use>"
user-invocable: true
metadata:
  {
    "openclaw": {
      "emoji": "🎥",
      "requires": {
        "bins": ["<cli-binary>"],
        "env": ["<primary-auth-env-var>"]
      },
      "primaryEnv": "<primary-auth-env-var>"
    }
  }
---
```

**Install locally for testing:**

```bash
mkdir -p ~/.openclaw/skills
ln -s "$(pwd)/integrations/openclaw/<skill>" ~/.openclaw/skills/<skill>
openclaw skills list   # should show the new skill
```

**Credentials go in `~/.openclaw/config.yaml`**, never in chat. The skill body must tell the host agent to refuse pasting tokens in chat — this is a recurring prompt-injection fail mode.

**Test in isolation** before going to chat: run the skill's declared CLI command directly (`<cli-binary> <typical-args>`) and confirm the approval UX works. If the CLI can't run standalone, OpenClaw won't magically fix it.

---

## Claude Code / Agenticode skill integration

Claude Code and `agenticode` (fork of Claude Code) look for skills at:

- **User-scope:** `~/.claude/skills/<name>/SKILL.md` (Claude Code) or `~/.agenticode/skills/<name>/SKILL.md` (agenticode; falls back to `~/.claude/skills/` if its own dir is empty)
- **Project-scope:** `.claude/skills/<name>/SKILL.md` or `.agenticode/skills/<name>/SKILL.md`
- **Plugin-scope:** inside an installed plugin at `<plugin>/skills/<name>/SKILL.md`

Frontmatter is nearly identical to OpenClaw — just drop the `metadata.openclaw` nesting and put fields at the top level:

```yaml
---
name: <skill-name>
description: "<trigger context — ≤1536 chars combined with when_to_use>"
when_to_use: "<optional extra context>"
user-invocable: true
allowed-tools: [Bash]
---
```

**Install locally:**

```bash
# Use the same dir for both CLIs via symlink — Claude Code is the primary.
mkdir -p ~/.claude/skills
ln -s "$(pwd)/integrations/claude-code/<skill>" ~/.claude/skills/<skill>

# Agenticode will pick it up from ~/.claude/skills/ by its legacy-fallback logic.
# If you want to keep them separate:
mkdir -p ~/.agenticode/skills
ln -s "$(pwd)/integrations/claude-code/<skill>" ~/.agenticode/skills/<skill>
```

Restart the CLI (or start a new session — skills are loaded on session start). Verify with `claude` (no args), then in the chat: `/<skill-name>` should appear in the slash-command menu (if `user-invocable: true`).

---

## Common commit convention

The agentic-work repos use imperative commit messages with a type prefix:

```
<type>(<scope>): <short imperative>

<body explaining WHY, not WHAT>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Types: `feat`, `fix`, `docs`, `test`, `ci`, `refactor`, `chore`. Always push to `main` directly (single-branch convention). PRs only when review is explicitly needed.

---

## Dependencies on cluster state

Before running CI locally or debugging, confirm:

```bash
kubectl get pods -n arc-systems       # arc-gha-rs-controller + listeners Running
kubectl get autoscalingrunnerset -n arc-runners    # all MAX >= 3
kubectl get svc -n sonarqube          # sonarqube-sonarqube + sonarqube-pg-postgresql ClusterIP
ssh hal 'uptime; free -h | head -2'   # load avg < 10, >2Gi memory available
```

If any of those are off, fix them **before** pushing another commit — the workflow runs will queue forever otherwise.
