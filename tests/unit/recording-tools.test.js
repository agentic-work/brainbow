// SPDX-License-Identifier: MIT
//
// AI-directed recording — the REST record→encode pipeline (server.js
// encodeRecording: jpeg frame buffer → ffmpeg → mp4/webm/gif) already existed
// but was unreachable from MCP (the only interface Claude drives). These tests
// pin the MCP tool surface that closes that gap.
//
// (a) record_start / record_stop / record_status / recordings_list are
//     registered with sane schemas.
// (b) record_stop is mp4-first (defaults format:mp4) — the website/social
//     target — even though the underlying REST route defaults to gif.
// (c) source-regression: the callTool switch routes each tool to its REST
//     endpoint via the shared brainbow() helper.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

describe('AI-directed recording — MCP tool surface', () => {
  it('(a) the 4 recording MCP tools are registered with sane schemas', async () => {
    const mod = await import('../../src/mcp-server.js');
    expect(Array.isArray(mod.TOOLS)).toBe(true);
    const byName = Object.fromEntries(mod.TOOLS.map((t) => [t.name, t]));

    for (const name of ['record_start', 'record_stop', 'record_status', 'recordings_list']) {
      expect(byName[name], `tool ${name} missing`).toBeTruthy();
      expect(byName[name].inputSchema?.type).toBe('object');
      expect(typeof byName[name].description).toBe('string');
      expect(byName[name].description.length).toBeGreaterThan(20);
    }
  });

  it('(b) record_stop is mp4-first (format enum + default mp4)', async () => {
    const mod = await import('../../src/mcp-server.js');
    const stop = mod.TOOLS.find((t) => t.name === 'record_stop');
    const fmt = stop.inputSchema.properties.format;
    expect(fmt.enum).toEqual(expect.arrayContaining(['mp4', 'webm', 'gif']));
    expect(fmt.default).toBe('mp4');
    // record_start exposes the optional zoom crop rect
    const start = mod.TOOLS.find((t) => t.name === 'record_start');
    expect(start.inputSchema.properties.zoom?.type).toBe('object');
  });

  it('(c) callTool routes each recording tool to its REST endpoint (source-regression)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'mcp-server.js'), 'utf8');
    // Each tool must hit the matching REST path through the shared brainbow() helper.
    expect(src).toMatch(/case 'record_start':[\s\S]*?\/api\/record\/start/);
    expect(src).toMatch(/case 'record_stop':[\s\S]*?\/api\/record\/stop/);
    expect(src).toMatch(/case 'record_status':[\s\S]*?\/api\/record\/status/);
    expect(src).toMatch(/case 'recordings_list':[\s\S]*?\/api\/recordings/);
    // record_stop must default the wire format to mp4 (not the REST gif default).
    expect(src).toMatch(/format:\s*args\.format\s*\?\?\s*'mp4'/);
  });
});
