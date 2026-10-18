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
      CREDENTIALS_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      // Account emails go to the small SMTP server the tests start on this port.
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '2526',
      SMTP_SECURE: 'false',
      SMTP_USER: '',
      SMTP_PASS: '',
      MAIL_FROM: 'JASthinkAboutIT <quiz@test.local>',
      FRONTEND_URL: 'https://quiz.test.local',
      LOGIN_MAX_FAILED_ATTEMPTS: '5',
      LOGIN_LOCK_MINUTES: '5',
    },
  },
});
