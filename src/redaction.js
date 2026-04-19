// SPDX-License-Identifier: MIT
//
// Secret redaction: scans text for likely-secrets (tokens, passwords,
// JWTs, OAuth params, Azure tenant GUIDs, emails) and replaces matches
// with asterisks. Used by every log line and broadcast frame so secrets
// never leave the process — see Invariant I5 in the foundation spec.

/**
 * Array of redaction regexes. Shared by `redactSecrets()`.
 *
 * NOTE: These RegExp instances have `/g` flag, which means their
 * `lastIndex` is mutated across calls. Do NOT call `.test()` or
 * `.exec()` on these patterns directly — use `redactSecrets()` which
 * resets `lastIndex` internally. Read-only inspection (array length,
 * instanceof checks) is safe.
 */
export const SECRET_PATTERNS = [
  /(?:password|passwd|pwd|pass|secret|token|api[_-]?key|auth|bearer|credential)\s*[=:]["']?\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(?:awc_|sk-|pk-|ghp_|gho_|github_pat_|xox[bpars]-)[A-Za-z0-9_-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  /(?:client[_-]?secret|access[_-]?key|secret[_-]?key)\s*[=:]["']?\s*\S+/gi,
  /(?:password|pwd)=[^&;\s"']+/gi,
  /[?&](?:client_id|tenant|state|code|nonce|id_token|access_token|refresh_token|assertion)=[^&\s"']+/gi,
  /login\.microsoftonline\.com\/[0-9a-f-]{36}/gi,
  /(?:oauth2|authorize|token|callback)[^"'\s]*[0-9a-f-]{36}/gi,
];

export function redactSecrets(text) {
  if (text === null || text === undefined) return text;
  if (text === '') return '';
  let result = String(text);
  for (const p of SECRET_PATTERNS) {
    p.lastIndex = 0;
    result = result.replace(p, (match) => {
      const eqIdx = match.search(/[=:]\s*/);
      if (eqIdx > 0) return match.substring(0, eqIdx + 1) + '******';
      if (/login\.microsoftonline/i.test(match)) return 'login.microsoftonline.com/******';
      if (match.length > 8) return match.substring(0, 4) + '******';
      return '******';
    });
  }
  return result;
}

Object.freeze(SECRET_PATTERNS);
