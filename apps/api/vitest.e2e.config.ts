import { defineConfig } from 'vitest/config';

/** Browser tests of the web app (see tests/e2e). Separate from the main suite: they need a browser. */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 240_000,
  },
});
