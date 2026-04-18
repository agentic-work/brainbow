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
      include: ['src/**/*.js', 'server.js'],
      exclude: [
        'ui.html',
        'scripts/**',
        'tests/**',
        'coverage/**',
        '**/*.config.js',
      ],
      // server.js is exercised via subprocess in trip-wires (ports 15001/15002)
      // so v8 cannot instrument it — overall line/statement coverage is ~20%
      // today. src/ files are ~90%. Thresholds will rise to 70/70/70/70 as
      // Plans 2-8 add tape DSL, MCP server, effects tests — see spec §15.
      thresholds: {
        lines: 20,
        branches: 55,
        functions: 75,
        statements: 20,
      },
    },
  },
});
