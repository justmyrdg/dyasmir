import fs from 'node:fs';
import path from 'node:path';

// Load backend/.env if present (Node >= 20.12 built-in, no dotenv needed).
const envFile = path.resolve(__dirname, '..', '.env');
const envFileFromDist = path.resolve(__dirname, '..', '..', '.env');
for (const file of [envFile, envFileFromDist]) {
  if (fs.existsSync(file)) {
    process.loadEnvFile(file);
    break;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: int('PORT', 3000),
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:4200',
  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 900),
  refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 7),
  loginMaxFailedAttempts: int('LOGIN_MAX_FAILED_ATTEMPTS', 5),
  loginLockMinutes: int('LOGIN_LOCK_MINUTES', 5),
  frontendDistDir: process.env.FRONTEND_DIST_DIR || undefined,
  enableAutoSubmitJob: process.env.DISABLE_AUTO_SUBMIT_JOB !== 'true',
};

if (config.jwtAccessSecret.length < 32) {
  throw new Error('JWT_ACCESS_SECRET must be at least 32 characters');
}
