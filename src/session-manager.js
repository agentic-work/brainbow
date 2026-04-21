// SPDX-License-Identifier: MIT
//
// SessionManager: owns Map<sessionId, Session>. Lazily creates sessions
// in local mode (the default-key UX); rejects unknown ids in cloud mode
// (per spec §7). The SessionClass dependency is injected so unit tests
// can stub the browser-launching Session.

const DEFAULT_SESSION_ID = 'default';

export class SessionManager {
  constructor({ SessionClass, mode = 'local' } = {}) {
    if (!SessionClass) {
      throw new Error('SessionManager requires a SessionClass dependency');
    }
    this.SessionClass = SessionClass;
    this.mode = mode;            // 'local' | 'cloud'
    this.sessions = new Map();
  }

  async get(sessionId = DEFAULT_SESSION_ID) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    if (this.mode === 'cloud') {
      const err = new Error(`unknown_session: ${sessionId}`);
      err.code = 'unknown_session';
      throw err;
    }
    return this.create(sessionId);
  }

  async create(sessionId = DEFAULT_SESSION_ID) {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }
    const session = new this.SessionClass(sessionId);
    this.sessions.set(sessionId, session);
    return session;
  }

  async remove(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try { await s.close(); } catch { /* swallow — already dying */ }
    this.sessions.delete(sessionId);
  }

  list() {
    return Array.from(this.sessions.keys());
  }

  /**
   * Return the session id most recently touched (by API call or frame emit).
   * Sessions track `lastActivityAt` via touch(). Falls back to the most
   * recently inserted session (Map iteration is insertion-order), and
   * finally to undefined if empty. Used by /api/whoami so opening the
   * viewer at `/` lands on the live session without picking.
   */
  mostRecentId() {
    let bestId;
    let bestTs = 0;
    for (const [id, sess] of this.sessions) {
      const ts = sess.lastActivityAt || 0;
      if (ts >= bestTs) {
        bestTs = ts;
        bestId = id;
      }
    }
    return bestId;
  }

  /**
   * Bump the lastActivityAt timestamp on a session. Called from the
   * server whenever a request is routed to a specific session so
   * mostRecentId() reflects real-world use, not just creation order.
   */
  touch(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) s.lastActivityAt = Date.now();
  }

  async closeAll() {
    const ids = this.list();
    for (const id of ids) {
      await this.remove(id);
    }
  }
}
