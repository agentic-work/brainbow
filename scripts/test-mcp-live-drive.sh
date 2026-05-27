#!/usr/bin/env bash
# Live-drive harness: spawn a sub-Claude in headless --print mode with
# brainbow tool pre-permitted, ask it to launch a browser + navigate +
# screenshot, then assert the screenshot file exists with non-zero size.
#
# This is the "100% working" gate. Registration alone isn't enough —
# the tools have to actually drive a real browser end-to-end.
#
# RED until brainbow shim+REST+mcp-server can drive a live navigation
# through a Claude-spawned tool invocation. GREEN when the sub-Claude
# returns a path to a real PNG file we can validate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

ISOLATED_CONFIG="${BRAINBOW_TEST_CONFIG:-/tmp/brainbow-livedrive-config.json}"
cat > "$ISOLATED_CONFIG" <<EOF
{
  "mcpServers": {
    "brainbow": {
      "type": "stdio",
      "command": "$REPO_ROOT/bin/brainbow-mcp",
      "args": [],
      "env": {
        "BRAINBOW_AUTOOPEN_VIEWER": "false"
      }
    }
  }
}
EOF

OUTPUT_FILE="${BRAINBOW_LIVE_OUTPUT:-/tmp/brainbow-livedrive-output.txt}"
DEBUG_FILE="${BRAINBOW_LIVE_DEBUG:-/tmp/brainbow-livedrive-debug.log}"
SCREENSHOT_DIR="${BRAINBOW_LIVE_SCREENSHOT_DIR:-/tmp/brainbow-livedrive-screenshots}"
mkdir -p "$SCREENSHOT_DIR"
: > "$OUTPUT_FILE" "$DEBUG_FILE"

# Use a stable sessionId for the test session.
TEST_SESSION="test-livedrive-$$"

PROMPT=$(cat <<EOF
Use the brainbow MCP tools to drive a real browser end-to-end.

Steps (perform IN ORDER, do not skip):
1. Call mcp__brainbow__launch with sessionId="${TEST_SESSION}" and url="https://example.com" and width=1280 and height=800.
2. Call mcp__brainbow__wait_for with sessionId="${TEST_SESSION}" and selector="h1" and timeout=10000 (so the page is fully loaded before screenshot).
3. Call mcp__brainbow__screen with sessionId="${TEST_SESSION}" and dom=true.

After step 3 completes, report ONE LINE only in this exact format:
  TEST_RESULT: launched=<true|false> waited=<true|false> screen_size=<bytes> dom_present=<true|false>

If any tool call returns an error, report:
  TEST_RESULT: ERROR <tool_name> <error_message>
EOF
)

echo "=== livedrive test (real browser navigation via sub-Claude) ==="
echo "    sessionId: $TEST_SESSION"
echo

set +e
timeout 90 claude \
  --print \
  --mcp-config "$ISOLATED_CONFIG" \
  --strict-mcp-config \
  --allowedTools "mcp__brainbow__launch,mcp__brainbow__screen,mcp__brainbow__goto,mcp__brainbow__close,mcp__brainbow__wait_for" \
  --output-format text \
  "$PROMPT" \
  > "$OUTPUT_FILE" 2> "$DEBUG_FILE"
CLAUDE_RC=$?
set -e

echo "=== sub-claude exit: $CLAUDE_RC ==="
echo
echo "=== sub-claude response ==="
cat "$OUTPUT_FILE"
echo
echo "=== stderr (last 40 lines) ==="
tail -40 "$DEBUG_FILE"
echo
echo "=== shim trace ==="
tail -10 /tmp/brainbow-shim-trace.log 2>/dev/null || echo "(no trace)"
echo
echo "=== REST processes alive ==="
ps aux | grep -E "brainbow/server\.js" | grep -v grep | head -3
echo

# Parse result line.
if grep -qE "TEST_RESULT: ERROR" "$OUTPUT_FILE"; then
  echo "=== RESULT: RED ==="
  grep "TEST_RESULT" "$OUTPUT_FILE"
  exit 1
elif grep -qE "TEST_RESULT: launched=true.*waited=true.*screen_size=[^0 ].*dom_present=true" "$OUTPUT_FILE" && ! grep -qE "screen_size=0\b|screen_size=null|screen_size=empty" "$OUTPUT_FILE"; then
  echo "=== RESULT: GREEN ==="
  grep "TEST_RESULT" "$OUTPUT_FILE"
  echo "Brainbow drove a real browser launch + screenshot end-to-end via sub-Claude."
  exit 0
elif grep -qE "TEST_RESULT:" "$OUTPUT_FILE"; then
  echo "=== RESULT: RED (assertions failed) ==="
  grep "TEST_RESULT" "$OUTPUT_FILE"
  exit 1
else
  echo "=== RESULT: RED (no TEST_RESULT line in output) ==="
  echo "Sub-Claude didn't produce a structured result. Inspect output above."
  exit 1
fi
