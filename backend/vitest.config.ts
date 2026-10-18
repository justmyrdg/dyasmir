import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      // Tests wipe data: never point this at the real database.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:dyasmir@localhost:5432/quiz_platform_test?schema=public',
      DISABLE_AUTO_SUBMIT_JOB: 'true',
      LOGIN_MAX_FAILED_ATTEMPTS: '5',
      LOGIN_LOCK_MINUTES: '5',
    },
  },
});
