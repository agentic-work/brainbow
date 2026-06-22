// SPDX-License-Identifier: MIT
//
// Claude-Code Opus-4.8 vision default — the model-selection decision logic.
//
// Pins task requirement #2: when launched inside a Claude Code session
// (CLAUDECODE=1 / AI_AGENT=claude-code*) and the operator has NOT pinned a
// model, brainbow defaults vision to Opus 4.8 via the best-available creds
// path — anthropic key → bedrock → honest local fallback + warning. An
// explicit pin always wins. These are PURE-function tests (env + creds-probe
// injected), so no network / no AWS / no Anthropic key is touched.

import { describe, it, expect } from 'vitest';
import {
  selectVisionModel,
  isClaudeCode,
  hasExplicitVisionPin,
  bedrockCredsLikely,
  OPUS_ANTHROPIC_ID,
  OPUS_BEDROCK_ID,
  DEFAULT_LOCAL_MODEL,
} from '../../src/vision-model-select.js';

const okBedrock = () => ({ ok: true, reason: 'test-profile' });
const noBedrock = () => ({ ok: false, reason: 'no-aws-creds-found' });

describe('isClaudeCode', () => {
  it('true when CLAUDECODE=1', () => {
    expect(isClaudeCode({ CLAUDECODE: '1' })).toBe(true);
  });
  it('true when AI_AGENT starts with claude-code', () => {
    expect(isClaudeCode({ AI_AGENT: 'claude-code_2-1-183_agent' })).toBe(true);
  });
  it('false for an unrelated env', () => {
    expect(isClaudeCode({ FOO: 'bar' })).toBe(false);
  });
});

describe('hasExplicitVisionPin', () => {
  it('true when BRAINBOW_VISION_MODEL is set', () => {
    expect(hasExplicitVisionPin({ BRAINBOW_VISION_MODEL: 'qwen2.5vl:7b' })).toBe(true);
  });
  it('true when provider differs from the launcher sentinel', () => {
    expect(hasExplicitVisionPin({ BRAINBOW_VISION_PROVIDER: 'openai' }, 'bedrock')).toBe(true);
  });
  it('false when provider equals the launcher auto sentinel (not operator-pinned)', () => {
    expect(hasExplicitVisionPin({ BRAINBOW_VISION_PROVIDER: 'bedrock' }, 'bedrock')).toBe(false);
  });
  it('false when nothing is set', () => {
    expect(hasExplicitVisionPin({}, 'bedrock')).toBe(false);
  });
});

describe('selectVisionModel — Claude Code Opus-4.8 default', () => {
  it('anthropic key present → provider=anthropic, model=claude-opus-4-8, no warn', () => {
    const d = selectVisionModel(
      { CLAUDECODE: '1', ANTHROPIC_API_KEY: 'sk-ant-xxx' },
      { autoProviderSentinel: 'bedrock', probeBedrock: noBedrock },
    );
    expect(d.provider).toBe('anthropic');
    expect(d.model).toBe(OPUS_ANTHROPIC_ID);
    expect(d.source).toBe('claude-code:anthropic-key');
    expect(d.warn).toBeNull();
    expect(d.explicit).toBe(false);
  });

  it('BRAINBOW_ANTHROPIC_API_KEY is also honored', () => {
    const d = selectVisionModel(
      { CLAUDECODE: '1', BRAINBOW_ANTHROPIC_API_KEY: 'sk-ant-yyy' },
      { autoProviderSentinel: 'bedrock', probeBedrock: noBedrock },
    );
    expect(d.provider).toBe('anthropic');
    expect(d.model).toBe(OPUS_ANTHROPIC_ID);
  });

  it('no anthropic key but bedrock creds → provider=bedrock, model=us.anthropic.claude-opus-4-8', () => {
    const d = selectVisionModel(
      { CLAUDECODE: '1' },
      { autoProviderSentinel: 'bedrock', probeBedrock: okBedrock },
    );
    expect(d.provider).toBe('bedrock');
    expect(d.model).toBe(OPUS_BEDROCK_ID);
    expect(d.source).toBe('claude-code:bedrock');
    expect(d.warn).toBeNull();
  });

  it('NEITHER cred path → local fallback + a CLEAR, VISIBLE warning (no silent pretend)', () => {
    const d = selectVisionModel(
      { CLAUDECODE: '1' },
      { autoProviderSentinel: 'bedrock', probeBedrock: noBedrock, localModel: 'moondream' },
    );
    expect(d.provider).toBe('ollama');
    expect(d.model).toBe('moondream');
    expect(d.source).toBe('claude-code:fallback-local');
    expect(d.warn).toBeTruthy();
    // The warning must name Opus-4.8 + the creds it needs, so the operator
    // is NOT misled into thinking Opus is narrating.
    expect(d.warn).toMatch(/Opus-4\.8/);
    expect(d.warn).toMatch(/ANTHROPIC_API_KEY|Bedrock/i);
    // It must NOT report opus as the active model.
    expect(d.model).not.toMatch(/opus/i);
  });

  it('explicit operator pin WINS even inside Claude Code (no auto-Opus override)', () => {
    const d = selectVisionModel(
      { CLAUDECODE: '1', BRAINBOW_VISION_PROVIDER: 'ollama', BRAINBOW_VISION_MODEL: 'qwen2.5vl:7b' },
      { autoProviderSentinel: 'bedrock', probeBedrock: okBedrock },
    );
    expect(d.explicit).toBe(true);
    expect(d.source).toBe('explicit');
    expect(d.model).toBe('qwen2.5vl:7b');
    expect(d.provider).toBe('ollama');
    expect(d.warn).toBeNull();
  });

  it('NOT a Claude Code session → no Opus default, leaves provider/model to existing chain', () => {
    const d = selectVisionModel(
      { /* no CLAUDECODE */ },
      { autoProviderSentinel: 'bedrock', probeBedrock: okBedrock },
    );
    expect(d.claudeCode).toBe(false);
    expect(d.source).toBe('not-claude-code');
    // does not force opus
    expect(d.model == null || !/opus/i.test(d.model)).toBe(true);
  });
});

describe('bedrockCredsLikely — cheap, no-STS heuristic', () => {
  it('true when ambient AWS_ACCESS_KEY_ID/SECRET are set', () => {
    const d = bedrockCredsLikely(
      { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' },
      { existsSync: () => false, homedir: () => '/home/x', join: (...p) => p.join('/') },
    );
    expect(d.ok).toBe(true);
    expect(d.reason).toMatch(/AWS_ACCESS_KEY_ID/);
  });

  it('true when ~/.aws config files exist on disk (optimistic — InvokeModel proves it)', () => {
    const d = bedrockCredsLikely(
      {},
      { existsSync: (p) => String(p).includes('.aws'), homedir: () => '/home/x', join: (...p) => p.join('/') },
    );
    expect(d.ok).toBe(true);
    expect(d.reason).toMatch(/aws-config-files|profile/);
  });

  it('false when no env creds and no aws files', () => {
    const d = bedrockCredsLikely(
      {},
      { existsSync: () => false, homedir: () => '/home/x', join: (...p) => p.join('/') },
    );
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('no-aws-creds-found');
  });
});
