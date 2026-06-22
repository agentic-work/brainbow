// SPDX-License-Identifier: MIT
//
// vision-model-select — decide which vision provider+model brainbow should
// use, with a SPECIAL CASE for Claude Code sessions.
//
// THE RULE (task requirement #2):
//   When brainbow is launched from inside a Claude Code session (CLAUDECODE=1
//   or AI_AGENT=claude-code*) AND the operator has NOT explicitly pinned a
//   vision model, brainbow should default its vision narrator to the SAME
//   class of model the Claude Code session itself runs on — Opus 4.8 — via
//   the best-available credential path:
//
//     1. ANTHROPIC_API_KEY / BRAINBOW_ANTHROPIC_API_KEY present
//          → provider=anthropic, model=claude-opus-4-8   (Anthropic API id)
//     2. else AWS Bedrock creds resolve (a profile / ambient creds)
//          → provider=bedrock,   model=us.anthropic.claude-opus-4-8 (Bedrock id)
//     3. else NEITHER cred path available
//          → provider=ollama,    model=<detected local vision model, e.g. moondream>
//            AND emit a CLEAR, VISIBLE warning that Opus-4.8 vision needs creds.
//            We do NOT silently pretend Opus is running.
//
// An EXPLICIT override always wins and short-circuits all of the above:
//   - BRAINBOW_VISION_MODEL set in the env, OR
//   - BRAINBOW_VISION_PROVIDER set to something other than the launcher's
//     own auto-default sentinel.
//
// This module is intentionally PURE + INJECTABLE (no global env reads at
// import time, no live network in the hot path) so it is unit-testable:
// callers pass in `{ env, probeBedrock }` and get back a plain decision
// object. The shim (bin/brainbow-mcp) and the Node server both consume it.

import { existsSync as fsExistsSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join as pathJoin } from 'node:path';

export const OPUS_ANTHROPIC_ID = 'claude-opus-4-8';
export const OPUS_BEDROCK_ID = 'us.anthropic.claude-opus-4-8';
export const DEFAULT_LOCAL_PROVIDER = 'ollama';
export const DEFAULT_LOCAL_MODEL = 'moondream';

/**
 * Is this process running inside a Claude Code session?
 * Claude Code sets CLAUDECODE=1 and AI_AGENT=claude-code_<ver>_agent.
 */
export function isClaudeCode(env = process.env) {
  if (String(env.CLAUDECODE || '') === '1') return true;
  if (/^claude-code/i.test(String(env.AI_AGENT || ''))) return true;
  return false;
}

/**
 * Did the operator EXPLICITLY pin a vision model/provider? An explicit pin
 * must always win over the Claude-Code auto-default.
 *
 * `autoProviderSentinel` is the value the launcher writes when it is merely
 * applying its OWN default (so the Node side can tell "user asked for bedrock"
 * apart from "launcher defaulted to bedrock"). When the provider equals the
 * sentinel we treat it as NOT explicit.
 */
export function hasExplicitVisionPin(env = process.env, autoProviderSentinel = '') {
  if (env.BRAINBOW_VISION_MODEL && String(env.BRAINBOW_VISION_MODEL).trim()) return true;
  const prov = String(env.BRAINBOW_VISION_PROVIDER || '').trim();
  if (prov && prov !== autoProviderSentinel) return true;
  return false;
}

/**
 * Cheap, synchronous heuristic for "do Bedrock creds plausibly resolve?".
 * We deliberately do NOT call STS here (slow + sts:GetCallerIdentity is often
 * DENIED even when bedrock:InvokeModel is ALLOWED — see this env's
 * bedrock-opus profile). Instead we look for the markers that mean a
 * credential source EXISTS; the real InvokeModel call is what ultimately
 * proves it, and the narrator surfaces InvokeModel errors via lastError.
 *
 * Returns { ok, reason }.
 */
export function bedrockCredsLikely(env = process.env, deps = {}) {
  const {
    existsSync = defaultExistsSync,
    homedir = defaultHomedir,
    join = defaultJoin,
  } = deps;

  // Ambient static creds in the environment.
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return { ok: true, reason: 'env:AWS_ACCESS_KEY_ID' };
  }
  // A named profile the operator pointed us at, or a dedicated bedrock profile.
  const profile = env.BRAINBOW_AWS_PROFILE || env.AWS_PROFILE || '';
  // Shared config / credentials files on disk.
  const home = homedir();
  const credFile = env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials');
  const cfgFile = env.AWS_CONFIG_FILE || join(home, '.aws', 'config');
  const haveFiles = safe(() => existsSync(credFile), false) || safe(() => existsSync(cfgFile), false);
  if (profile && haveFiles) return { ok: true, reason: `profile:${profile}` };
  if (haveFiles) return { ok: true, reason: 'aws-config-files' };
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE) return { ok: true, reason: 'web-identity' };
  return { ok: false, reason: 'no-aws-creds-found' };
}

/**
 * THE decision. Pure: returns
 *   { provider, model, source, reason, warn|null, claudeCode, explicit }
 *
 * @param {object} env                 the environment to read (default process.env)
 * @param {object} deps
 *   @param {string} deps.autoProviderSentinel  provider value the launcher writes
 *                                              for its own auto-default (so we can
 *                                              tell explicit-bedrock apart)
 *   @param {function} deps.probeBedrock        () => { ok, reason } creds check
 *   @param {string}  deps.localModel           detected local vision model id
 */
export function selectVisionModel(env = process.env, deps = {}) {
  const {
    autoProviderSentinel = '',
    probeBedrock = (e) => bedrockCredsLikely(e),
    localModel = DEFAULT_LOCAL_MODEL,
    localProvider = DEFAULT_LOCAL_PROVIDER,
  } = deps;

  const claudeCode = isClaudeCode(env);
  const explicit = hasExplicitVisionPin(env, autoProviderSentinel);

  // Explicit operator pin, or not a Claude Code session → no auto-Opus default.
  // Return the env's own provider/model (or empty so the caller keeps its
  // existing default chain).
  if (explicit || !claudeCode) {
    return {
      provider: env.BRAINBOW_VISION_PROVIDER || null,
      model: env.BRAINBOW_VISION_MODEL || null,
      source: explicit ? 'explicit' : 'not-claude-code',
      reason: explicit ? 'operator pinned BRAINBOW_VISION_MODEL/PROVIDER' : 'not a Claude Code session',
      warn: null,
      claudeCode,
      explicit,
    };
  }

  // Claude Code, no explicit pin → aim for Opus 4.8 via best creds.
  const anthropicKey = env.BRAINBOW_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || '';
  if (anthropicKey && anthropicKey.trim()) {
    return {
      provider: 'anthropic',
      model: OPUS_ANTHROPIC_ID,
      source: 'claude-code:anthropic-key',
      reason: 'ANTHROPIC_API_KEY present → Opus 4.8 via Anthropic API',
      warn: null,
      claudeCode,
      explicit,
    };
  }

  const bed = probeBedrock(env);
  if (bed?.ok) {
    return {
      provider: 'bedrock',
      model: OPUS_BEDROCK_ID,
      source: 'claude-code:bedrock',
      reason: `Bedrock creds (${bed.reason}) → Opus 4.8 via Bedrock`,
      warn: null,
      claudeCode,
      explicit,
    };
  }

  // No cred path → honest local fallback + visible warning.
  return {
    provider: localProvider,
    model: localModel,
    source: 'claude-code:fallback-local',
    reason: `no Opus-4.8 creds (${bed?.reason || 'none'}) → local ${localProvider}/${localModel}`,
    warn:
      `[brainbow] Claude Code session detected (Opus 4.8) but NO vision creds available ` +
      `(no ANTHROPIC_API_KEY, ${bed?.reason || 'no-aws-creds'}). ` +
      `Falling back to local ${localProvider}/${localModel} for vision narration. ` +
      `To get Opus-4.8 VISION: set ANTHROPIC_API_KEY, or provide working AWS Bedrock creds ` +
      `(profile with bedrock:InvokeModel on ${OPUS_BEDROCK_ID}).`,
    claudeCode,
    explicit,
  };
}

// ─── tiny dependency-free helpers ─────────────────────────────────────────
// Defaults delegate to node:fs/os/path; tests inject their own so the pure
// decision logic never needs a real filesystem.
function safe(fn, fb) { try { return fn(); } catch { return fb; } }
function defaultExistsSync(p) { return fsExistsSync(p); }
function defaultHomedir() { return osHomedir(); }
function defaultJoin(...parts) { return pathJoin(...parts); }
