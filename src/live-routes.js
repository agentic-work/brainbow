// SPDX-License-Identifier: MIT
//
// live-routes — multi-source LIVE observation endpoints.
//
// Adds to the existing Express app:
//   POST /api/vision/live/start        kick off Bedrock Sonnet narrator
//   POST /api/vision/live/stop         stop narrator
//   GET  /api/vision/live/narration    return narration entries since cursor
//   POST /api/log/subscribe            start a log tail (kubectl logs -f, etc)
//   POST /api/log/unsubscribe          stop a tail
//   GET  /api/log/list                 list active tails
//   GET  /api/log/snapshot             snapshot all tails since cursor
//   GET  /api/live                     one-shot multi-source response
//
// /api/live is THE keystone. One call returns everything the AI agent needs
// to "see" the live state: current frame (base64 JPEG), the narration delta
// since last call, the DOM structural snapshot, the console delta, and the
// log tail delta. The caller passes `?cursor=<ms>` and gets back the new
// `cursor` to use next time.

import { sharedVisionNarrator } from './vision-narrator.js';
import { LogTailManager } from './log-tail.js';

const sharedLogTails = new LogTailManager();

// Per-session live cursor state. Stores the timestamp of the last
// snapshot returned to a caller so subsequent calls can return only the
// delta. Keyed by sessionId. Stored here (not on Session) so that
// resetting brainbow doesn't blow it up — but it'd be reasonable to
// move this onto Session in a future pass.
const liveCursors = new Map();

async function safe(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

async function captureDomSnapshot(session) {
  if (!session.page) return null;
  return safe(async () => {
    return session.page.evaluate(() => {
      const counts = {
        toolCards: document.querySelectorAll('[data-testid*="tool-card"], .tool-card, .cm-tool-card').length,
        thinkingBlocks: document.querySelectorAll('.inline-thinking-block, .inline-thinking-natural').length,
        iframes: document.querySelectorAll('iframe').length,
        subAgentCards: document.querySelectorAll('[data-testid*="subagent"], .sub-agent-card').length,
        streamingTables: document.querySelectorAll('.streaming-table, [data-testid*="streaming-table"]').length,
        followupChips: document.querySelectorAll('[data-testid*="follow-up"], .followup-chip').length,
        hitlChips: document.querySelectorAll('[data-test-hitl-action], .hitl-approval-card').length,
        messages: document.querySelectorAll('[data-testid*="message"], .message-bubble').length,
        forms: document.querySelectorAll('form').length,
        buttons: document.querySelectorAll('button').length,
        inputs: document.querySelectorAll('input, textarea').length,
      };
      const isStreaming = document.querySelector('[data-streaming="true"]') != null;
      const bodyText = (document.body?.innerText || '').slice(-2000);
      const title = document.title;
      const url = location.href;
      return { counts, isStreaming, bodyTextTail: bodyText, title, url };
    });
  });
}

function pickNewSince(arr = [], cursorTs = 0, tsKey = 'ts') {
  if (!cursorTs) return arr.slice();
  return arr.filter(e => (e?.[tsKey] || 0) > cursorTs);
}

export function registerLiveRoutes(app, { sessionManager, getSession }) {
  // ─── Bedrock narrator lifecycle ────────────────────────────────────────
  app.post('/api/vision/live/start', async (req, res) => {
    const session = await getSession(req, res);
    if (!session) return;
    sharedVisionNarrator.start(session);
    res.json({
      ok: true,
      watching: true,
      interval_ms: sharedVisionNarrator.intervalMs,
      provider: sharedVisionNarrator.providerName,
      model: sharedVisionNarrator.model,
      sessionId: session.sessionId,
    });
  });

  app.post('/api/vision/live/stop', async (req, res) => {
    const session = await getSession(req, res);
    if (!session) return;
    sharedVisionNarrator.stop(session);
    res.json({ ok: true, watching: false, sessionId: session.sessionId });
  });

  app.get('/api/vision/live/narration', async (req, res) => {
    const session = await getSession(req, res);
    if (!session) return;
    const cursor = Number.parseInt(req.query.cursor || '0');
    const entries = pickNewSince(session.visionNarration || [], cursor, 'ts');
    res.json({
      sessionId: session.sessionId,
      watching: !!session.visionWatching,
      provider: sharedVisionNarrator.providerName,
      model: sharedVisionNarrator.model,
      lastError: session.visionError || null,
      cursor: Date.now(),
      entries,
    });
  });

  // ─── Log tails ────────────────────────────────────────────────────────
  app.post('/api/log/subscribe', async (req, res) => {
    try {
      const { name, command } = req.body || {};
      const status = sharedLogTails.subscribe({ name, command });
      res.json({ ok: true, ...status });
    } catch (e) {
      const code = e?.code === 'log_tails_disabled' ? 403
        : e?.code === 'log_tail_exists' ? 409
        : 400;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/log/unsubscribe', async (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const ok = sharedLogTails.unsubscribe(name);
    res.json({ ok, name });
  });

  app.get('/api/log/list', async (_req, res) => {
    res.json({ enabled: sharedLogTails.enabled, tails: sharedLogTails.list() });
  });

  app.get('/api/log/snapshot', async (req, res) => {
    const cursor = Number.parseInt(req.query.cursor || '0');
    const tails = sharedLogTails.snapshot(cursor);
    res.json({ cursor: Date.now(), tails });
  });

  // ─── THE KEYSTONE — /api/live ─────────────────────────────────────────
  app.get('/api/live', async (req, res) => {
    const session = await getSession(req, res);
    if (!session) return;
    const cursorParam = Number.parseInt(req.query.cursor || '0');
    const cursor = cursorParam || liveCursors.get(session.sessionId) || 0;
    const now = Date.now();

    const wantImage = req.query.image !== 'false';
    const wantDom = req.query.dom !== 'false';

    const [dom, consoleDelta, actionDelta, narrationDelta] = await Promise.all([
      wantDom ? captureDomSnapshot(session) : Promise.resolve(null),
      Promise.resolve(pickNewSince(session.consoleMessages || [], cursor, 'ts')),
      Promise.resolve(pickNewSince((session.actionLog || []).map(a => ({ ...a, ts: Date.parse(a.ts) || Date.now() })), cursor, 'ts')),
      Promise.resolve(pickNewSince(session.visionNarration || [], cursor, 'ts')),
    ]);
    const logsDelta = sharedLogTails.snapshot(cursor);

    const lastFrame = wantImage ? session.lastFrameB64 : null;

    liveCursors.set(session.sessionId, now);

    res.json({
      sessionId: session.sessionId,
      cursor: now,
      url: dom?.url || session.page?.url?.() || null,
      title: dom?.title || null,
      image: lastFrame,                     // base64 JPEG (most recent CDP frame)
      imageMimeType: lastFrame ? 'image/jpeg' : null,
      dom: dom ? { counts: dom.counts, isStreaming: dom.isStreaming, bodyTextTail: dom.bodyTextTail } : null,
      narrationDelta,                       // Bedrock Sonnet narration entries since cursor
      consoleDelta,                         // page console messages since cursor
      actionDelta,                          // brainbow action log since cursor
      logsDelta,                            // { tailName: [{ts,stream,line}, ...] }
      narration: {
        watching: !!session.visionWatching,
        // BUGFIX: previously read a non-existent model-id getter (the real
        // getter is `.model`), so /api/live (the keystone) returned undefined
        // for the vision model. screen/live/vision_model all read this field.
        provider: sharedVisionNarrator.providerName,
        model: sharedVisionNarrator.model,
        lastError: session.visionError || null,
        latestBody: session.visionDescription || null,
        latestTs: session.visionTimestamp || 0,
      },
      logTailsEnabled: sharedLogTails.enabled,
    });
  });
}

export { sharedLogTails };
