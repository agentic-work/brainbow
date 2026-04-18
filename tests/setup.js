// SPDX-License-Identifier: MIT
//
// Global test setup. Tests that spin up Express should use an
// OS-assigned port to avoid collisions across parallel vitest workers:
//
//   const server = app.listen(0);
//   const { port } = server.address();
//
// …never `server.listen(14444)` or any other hardcoded number. Vitest
// runs test files in worker threads by default (vitest 1.x), and
// hardcoded ports race across workers.
import { afterEach } from 'vitest';

afterEach(async () => {
  // Give Chromium a beat to fully release ports between tests.
  await new Promise(r => setTimeout(r, 50));
});
