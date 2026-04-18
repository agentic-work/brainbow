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
    expect(redactSecrets(jwt)).not.toContain(jwt);
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

  it('exposes SECRET_PATTERNS as an array of RegExp', () => {
    expect(Array.isArray(SECRET_PATTERNS)).toBe(true);
    expect(SECRET_PATTERNS.length).toBeGreaterThan(5);
    SECRET_PATTERNS.forEach(p => expect(p).toBeInstanceOf(RegExp));
  });
});
