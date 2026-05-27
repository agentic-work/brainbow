// SPDX-License-Identifier: MIT
//
// stream-log — one NDJSON file, all live events.
//
// When BRAINBOW_FRAME_LOG=/path/to/foo.ndjson is set, every event source
// in brainbow appends ONE line to that file:
//
//   {"type":"frame",     "ts":..., "sessionId":..., "url":..., "path":"/tmp/.../frame.jpg"}
//   {"type":"narration", "ts":..., "sessionId":..., "body":"..."}
//   {"type":"narration", "ts":..., "sessionId":..., "error":"..."}
//   {"type":"log",       "ts":..., "name":"api",   "stream":"stdout", "line":"..."}
//
// An AI client with no streaming primitive (request/response only) gets
// stream-to-brain by `Monitor`ing this file: each new NDJSON line fires
// a notification, the client `Read`s the line, and for frame events the
// embedded `path` lets the client `Read` the actual JPEG.
//
// Synchronous append for ordering safety; the file is local and tiny.

import fs from 'node:fs';

let _path = process.env.BRAINBOW_FRAME_LOG || '';
let _warned = false;

export function getStreamLogPath() { return _path; }
export function setStreamLogPath(p) { _path = p || ''; }

export function appendStreamEvent(obj) {
  if (!_path) return;
  if (!obj || typeof obj !== 'object') return;
  try {
    const line = JSON.stringify({ ...obj, ts: obj.ts || Date.now() }) + '\n';
    fs.appendFileSync(_path, line);
  } catch (e) {
    if (!_warned) {
      console.error(`[stream-log] append failed: ${e?.message || e}`);
      _warned = true;
    }
  }
}
