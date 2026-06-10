// SPDX-License-Identifier: MIT
//
// viewer-open — on-demand "open the live viewer in the user's default
// browser" logic (Bug 2).
//
// The viewer used to AUTO-open a (Windows) browser window on every MCP
// launch / WSL start (bin/brainbow-mcp defaulted BRAINBOW_AUTOOPEN_VIEWER
// to true). The user wants it agent/human-CONTROLLABLE — never auto-popping.
//
// This module:
//   - openInBrowser(url): runs the same opener chain the launcher used
//     (wslview → cmd.exe → xdg-open → open). Returns the opener name that
//     succeeded, or null if none could open it. Best-effort, never throws.
//   - makeViewerOpenHandler(opts): builds the Express handler for
//     POST /api/viewer/open. Returns { ok, url, opener }. The opener fn is
//     injectable so unit tests never actually spawn a browser.

import { spawn } from 'node:child_process';

/**
 * Open `url` in the user's default browser using the first opener available.
 * Mirrors bin/brainbow-mcp's open_viewer chain. Fire-and-forget per opener:
 * a spawned child emits 'error' asynchronously (ENOENT etc) AFTER spawn()
 * returns — with no listener that surfaces as an uncaughtException, so we
 * attach a no-op error listener and unref each child.
 *
 * Returns the opener name that launched (e.g. 'wslview'), or null if none
 * were found / all failed.
 */
export function openInBrowser(url) {
  const tryOpen = (cmd, args) => {
    try {
      const c = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      c.on('error', () => {});   // async ENOENT — swallow, never crash us
      c.unref();
      return true;
    } catch { return false; }
  };
  if (tryOpen('wslview', [url])) return 'wslview';
  if (tryOpen('cmd.exe', ['/c', 'start', '', url])) return 'cmd.exe';
  if (process.env.DISPLAY && tryOpen('xdg-open', [url])) return 'xdg-open';
  if (tryOpen('open', [url])) return 'open';
  return null;
}

/**
 * Build the POST /api/viewer/open route handler.
 *
 * @param {object} opts
 * @param {number} opts.port               REST port (for the viewer URL host).
 * @param {function} [opts.openInBrowser]  Injectable opener (defaults to the
 *                                         real openInBrowser). Tests pass a fake.
 * @param {function} [opts.defaultSessionId] Returns the session id to use when
 *                                         the request omits one.
 */
export function makeViewerOpenHandler(opts = {}) {
  const port = opts.port || 4444;
  const opener = opts.openInBrowser || openInBrowser;
  const defaultSessionId = opts.defaultSessionId || (() => 'default');

  return async function viewerOpenHandler(req, res) {
    const sessionId = req.body?.sessionId || defaultSessionId();
    const url = `http://localhost:${port}/?sessionId=${encodeURIComponent(sessionId)}`;
    let usedOpener = null;
    try {
      usedOpener = opener(url);
    } catch {
      usedOpener = null;
    }
    res.status(200).json({ ok: !!usedOpener, url, opener: usedOpener });
  };
}
