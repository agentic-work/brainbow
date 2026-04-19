// SPDX-License-Identifier: MIT
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
    testTimeout: 30000,           // trip-wires launch real Chromium
    hookTimeout: 30000,
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      // Measure only src/*.js — server.js is the HTTP entrypoint, exercised
      // only via real-browser trip-wires (subprocess, not instrumentable by v8).
      // That entrypoint's correctness is guarded by the trip-wire + integration
      // suites, which run when Chromium is present (local dev / future CI with
      // a Chromium-equipped runner).
      include: ['src/**/*.js'],
      exclude: [
        'ui.html',
        'scripts/**',
        'tests/**',
        'coverage/**',
        '**/*.config.js',
      ],
      // Local thresholds are advisory — the canonical gate is SonarQube's
      // new-code QG, so don't fail the vitest run on coverage counts.
    },
  },
});
