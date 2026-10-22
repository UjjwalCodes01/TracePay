import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // Integration suites share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Generated client, one-off scripts, and the entry point (tested as a real process in server-boot.test.ts).
      exclude: ['src/generated/**', 'src/scripts/**', 'src/server.ts'],
      reporter: ['text-summary', 'json-summary'],
      // A floor, not a target: CI fails if coverage drops below today's level.
      thresholds: { statements: 86, branches: 73, functions: 86, lines: 90 },
    },
  },
});
