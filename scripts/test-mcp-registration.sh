#!/usr/bin/env bash
# Test harness: prove that brainbow MCP tools actually register in a real
# Claude Code session. Spawns a second Claude in headless --print mode with
# an isolated --mcp-config containing ONLY brainbow, captures --debug output
# so we see WHY mcp-server.js dies (if it does), and asserts that brainbow
# tools appear in the spawned Claude's tool list.
#
# RED state today: 30s timeout on /mcp reconnect, brainbow tools never appear
# in the tool list despite the shim spawning REST successfully.
#
# GREEN state: brainbow tools (screen, live, launch, etc.) appear when the
# isolated Claude is asked to list MCP tools.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

# Isolated MCP config pointing at this brainbow shim only.
ISOLATED_CONFIG="${BRAINBOW_TEST_CONFIG:-/tmp/brainbow-test-mcp-config.json}"
cat > "$ISOLATED_CONFIG" <<EOF
{
  "mcpServers": {
    "brainbow": {
      "type": "stdio",
      "command": "$REPO_ROOT/bin/brainbow-mcp",
      "args": [],
      "env": {
        "BRAINBOW_VISION_AUTOSTART": "true",
        "BRAINBOW_LOG_TAILS_ENABLED": "true",
        "AWS_REGION": "us-east-1",
        "BRAINBOW_AUTOOPEN_VIEWER": "false"
      }
    }
  }
}
EOF

OUTPUT_FILE="${BRAINBOW_TEST_OUTPUT:-/tmp/brainbow-test-output.txt}"
DEBUG_FILE="${BRAINBOW_TEST_DEBUG:-/tmp/brainbow-test-debug.log}"
: > "$OUTPUT_FILE" "$DEBUG_FILE"

echo "=== test config ==="
cat "$ISOLATED_CONFIG"
echo

echo "=== nuking stale brainbow state for clean run ==="
pkill -TERM -f "brainbow/server\.js" 2>/dev/null || true
pkill -TERM -f "brainbow/src/mcp-server\.js" 2>/dev/null || true
sleep 1
rm -f "$HOME/.cache/brainbow/port-"* "$HOME/.cache/brainbow/.viewer-opened-once-"* 2>/dev/null || true
rm -f /tmp/brainbow-shim-trace.log
touch /tmp/brainbow-shim-trace.log

echo "=== spawning isolated Claude headless with --debug to capture MCP errors ==="
echo "    (this proves what Claude Code's MCP host actually sees)"
echo

# `claude --print` runs one-shot. `--mcp-config + --strict-mcp-config` uses
# ONLY our isolated config (ignores ~/.claude.json). `--debug` emits MCP
# stderr from the shim/server into our visible output. Timeout 45s so we
# see the timeout fire if it happens, plus a few seconds margin.
#
# Prompt asks Claude to call a brainbow tool. If brainbow registered, the
# call succeeds and we see real tool output. If not, Claude says it
# doesn't have access to that tool.
PROMPT='Call the mcp__brainbow__sessions tool with no arguments. Report ONLY the literal JSON response from the tool — do not paraphrase. If the tool is not available in your toolset, respond with exactly: BRAINBOW_NOT_REGISTERED'

# Scenario A: isolated config (proves shim works alone).
# Scenario B: real user config (~/.claude.json + all other MCPs).
# Default to B unless BRAINBOW_TEST_ISOLATED=true.
SCENARIO="${BRAINBOW_TEST_SCENARIO:-real}"

set +e
if [ "$SCENARIO" = "isolated" ]; then
  echo "    scenario: ISOLATED (brainbow only via --strict-mcp-config)"
  timeout 60 claude \
    --print \
    --mcp-config "$ISOLATED_CONFIG" \
    --strict-mcp-config \
    --debug \
    --output-format text \
    "$PROMPT" \
    > "$OUTPUT_FILE" 2> "$DEBUG_FILE"
else
  echo "    scenario: REAL (all MCPs from ~/.claude.json — the actual user scenario)"
  timeout 60 claude \
    --print \
    --debug \
    --output-format text \
    "$PROMPT" \
    > "$OUTPUT_FILE" 2> "$DEBUG_FILE"
fi
CLAUDE_RC=$?
set -e

echo "=== claude exit code: $CLAUDE_RC ==="
echo
echo "=== STDOUT (Claude's response) ==="
cat "$OUTPUT_FILE"
echo
echo "=== STDERR (MCP debug — this is what Claude's MCP host actually saw) ==="
tail -120 "$DEBUG_FILE"
echo
echo "=== shim trace ==="
cat /tmp/brainbow-shim-trace.log
echo

# Assertion: brainbow tools registered if response shows ANY evidence of the
# tool existing in the toolset. Permission denial is expected in --print
# mode (no human to approve), so we ONLY treat "literal NOT_REGISTERED with
# no self-correction" as RED.
#
# Sub-Claudes often respond "BRAINBOW_NOT_REGISTERED" then immediately
# self-correct ("Wait — the tool IS registered, just permission-denied").
# We must detect the corrected statement, not the initial sentinel.
if grep -qiE "tool .*exists|tool .*is registered|tool .*is available|schema loaded|permission.*den|haven't granted|requested permissions|sessionId" "$OUTPUT_FILE"; then
  echo "=== RESULT: GREEN ==="
  echo "Brainbow MCP tools registered into the spawned Claude's toolset."
  echo "(Permission denial in --print mode is expected; what matters is the tool IS present.)"
  exit 0
elif grep -q "BRAINBOW_NOT_REGISTERED" "$OUTPUT_FILE"; then
  echo "=== RESULT: RED ==="
  echo "Brainbow MCP tools did NOT register in spawned Claude's toolset."
  echo "Check STDERR above for the actual MCP error."
  exit 1
else
  echo "=== RESULT: AMBIGUOUS ==="
  echo "Neither sentinel found nor tool-result evidence. Inspect output."
  exit 2
fi
