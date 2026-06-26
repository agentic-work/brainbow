// SPDX-License-Identifier: MIT
//
// Pre-public leak guard — no internal infrastructure, hostnames, or
// AI-attribution strings may appear in any tracked file.
//
// brainbow is published as a public OSS MCP server. Internal cluster topology
// (SonarQube/ARC hostnames, the `hal` GPU box, dev namespaces), internal service
// URLs, and `Co-Authored-By: Claude` / `noreply@anthropic` commit trailers must
// never ship in the public tree. This scans every git-tracked text file and
// fails if any forbidden pattern is present, so a leak can't silently return.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = execSync('git rev-parse --show-toplevel').toString().trim();
const SELF = fileURLToPath(import.meta.url);

// label -> regex. Specific enough to catch real leaks without flagging the public
// brand (agenticwork.io is fine; the internal *-dev hosts / GPU box are not).
const FORBIDDEN = [
  ['internal SonarQube host', /sonarqube-dev\.agenticwork\.io/],
  ['internal chat host', /chat-dev\.agenticwork\.io/],
  ['internal GPU box hostname', /\bhal\b/],
  ['internal GPU box ssh', /\bssh hal\b/],
  ['internal lab IP block', /\b10\.2\.10\./],
  ['internal dev namespace', /\bagentic-dev\b/],
  ['internal ARC runner', /\barc-brainbow\b/],
  ['AI co-author trailer', /Co-Authored-By:\s*Claude/],
  ['Anthropic noreply', /noreply@anthropic/],
  ['proprietary header', /Proprietary and confidential/],
];

function trackedTextFiles() {
  return execSync('git ls-files -z', { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((rel) => path.resolve(REPO_ROOT, rel))
    .filter((p) => p !== SELF && statSync(p).isFile());
}

describe('pre-public leak guard', () => {
  it('has no internal-infra or AI-attribution strings in tracked files', () => {
    const violations = [];
    for (const file of trackedTextFiles()) {
      let text;
      try {
        const buf = readFileSync(file);
        if (buf.includes(0)) continue; // NUL byte => binary (png/ico/woff/...) — skip
        text = buf.toString('utf8');
      } catch {
        continue; // unreadable
      }
      const rel = path.relative(REPO_ROOT, file);
      for (const [label, rx] of FORBIDDEN) {
        const g = new RegExp(rx.source, 'g');
        let m;
        while ((m = g.exec(text)) !== null) {
          const line = text.slice(0, m.index).split('\n').length;
          violations.push(`${rel}:${line}: ${label} (${JSON.stringify(m[0])})`);
        }
      }
    }
    expect(violations, `Pre-public leak(s) found:\n${violations.sort().join('\n')}`).toEqual([]);
  });
});
