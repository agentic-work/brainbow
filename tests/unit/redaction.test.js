// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { redactSecrets, SECRET_PATTERNS } from '../../src/redaction.js';

describe('redactSecrets', () => {
  it('redacts password=value', () => {
    expect(redactSecrets('password=hunter2')).toMatch(/password=\*+/);
  });

  it('redacts Bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toMatch(/Bear\*+/);
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + 'a'.repeat(40) + '.' + 'b'.repeat(40);
    const result = redactSecrets(jwt);
    expect(result).not.toContain(jwt);
    expect(result).toMatch(/^eyJh\*+/);  // prefix-preserving replacement
  });

  it('redacts email addresses', () => {
    expect(redactSecrets('user@example.com')).not.toContain('user@example.com');
  });

  it('redacts Azure tenant GUIDs in login URLs', () => {
    const url = 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/oauth2/authorize';
    expect(redactSecrets(url)).toContain('login.microsoftonline.com/******');
  });

  it('redacts api_key=value', () => {
    expect(redactSecrets('api_key=sk-abc123')).toMatch(/api_key=\*+/);
  });

  it('returns input unchanged when no secrets present', () => {
    expect(redactSecrets('plain text with no secrets')).toBe('plain text with no secrets');
  });

  it('returns empty string for empty input', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('returns null/undefined unchanged', () => {
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(undefined)).toBe(undefined);
  });

  it('redacts ghp_ GitHub personal access tokens', () => {
    expect(redactSecrets('ghp_abc1234567890xyzABCDEF')).not.toContain('ghp_abc1234567890xyzABCDEF');
  });

  it('fully redacts short Bearer tokens (≤8 chars total)', () => {
    // "Bearer a" — matches the Bearer pattern but length is 8, not > 8,
    // so the catch-all '******' branch hits. No prefix-preserve here.
    expect(redactSecrets('Authorization: Bearer a')).toContain('******');
    expect(redactSecrets('Authorization: Bearer a')).not.toContain('Bearer a');
  });

  it('redacts sk- API keys', () => {
    expect(redactSecrets('sk-proj-abc1234567890')).not.toContain('sk-proj-abc1234567890');
  });

  it('redacts xoxb- Slack bot tokens', () => {
    expect(redactSecrets('xoxb-1234567890-abcdefgh')).not.toContain('xoxb-1234567890-abcdefgh');
  });

  it('does NOT redact bare state= in log messages', () => {
    expect(redactSecrets('connection state=active')).toBe('connection state=active');
  });

  it('does NOT redact bare code= in log messages', () => {
    expect(redactSecrets('process exited with code=1')).toBe('process exited with code=1');
  });

  it('redacts state= when in URL query string context', () => {
    expect(redactSecrets('/callback?state=abc123def456')).toMatch(/state=\*+/);
  });

  it('exposes SECRET_PATTERNS as an array of RegExp', () => {
    expect(Array.isArray(SECRET_PATTERNS)).toBe(true);
    expect(SECRET_PATTERNS.length).toBeGreaterThan(5);
    SECRET_PATTERNS.forEach(p => expect(p).toBeInstanceOf(RegExp));
  });
});
