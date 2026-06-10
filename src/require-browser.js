// SPDX-License-Identifier: MIT
//
// requireBrowser — the auto-recover guard every browser-touching REST
// endpoint runs before delegating to the Session.
//
// HISTORY / THE BUG IT FIXES (Bug 1 — "session drops constantly"):
//   The chromium `disconnected` handler in src/session.js NULLS
//   session.browser the instant Chromium drops (WSL2 fires this often via
//   GPU/renderer/shm crashes). The OLD guard gated recovery on
//   `session.browser`:
//
//       if (session.browser && !session.isAlive()) await session.ensureBrowser();
//       if (!session.page) return 400 "No browser open. POST /api/launch first.";
//
//   So the moment the handler nulled session.browser, the recover condition
//   was FALSE → ensureBrowser() was SKIPPED → every subsequent /api/eval,
//   /api/screen, /api/click returned "No browser open." The self-healing was
//   defeated by its own disconnect handler.
//
//   THE FIX: gate recovery on a DURABLE flag — `session.wasLaunched` — that
//   survives a disconnect (the handler may null the dead browser/page/cdp/tabs
//   but must NOT clear wasLaunched/lastUrl). A session that was EVER launched
//   and is not currently alive is relaunched transparently. After the relaunch
//   resolves we RE-CHECK session.page and only 400 if it is STILL null.
//
//   The "never auto-spawn for a bare caller" intent is preserved: a session
//   that was never launched (wasLaunched falsy) still gets the 400 — we do not
//   silently spin up Chromium for a /api/eval that never had a browser.
//
// Extracted into its own module so it is unit-testable without binding the
// REST server's port.

export async function requireBrowser(session, res) {
  // Auto-recover a crashed/dropped Chromium. Gate on the DURABLE
  // `wasLaunched` flag, NOT `session.browser` — the disconnect handler nulls
  // session.browser, so checking it skips the very recovery it needs.
  if (session.wasLaunched && !session.isAlive()) {
    try {
      await session.ensureBrowser();
      session.log?.('auto-recover', 'browser was dead — relaunched before action');
    } catch (e) {
      res.status(503).json({ error: `Browser crashed and relaunch failed: ${e.message}` });
      return false;
    }
  }
  // Re-check AFTER any relaunch: ensureBrowser() may have brought the page
  // back. Only 400 if there is still no usable page (never launched, or the
  // relaunch failed to produce one).
  if (!session.page) {
    res.status(400).json({ error: 'No browser open. POST /api/launch first.' });
    return false;
  }
  return true;
}
