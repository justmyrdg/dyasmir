import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { Role } from './auth.types';

export const REFRESH_COOKIE = 'qp_rt';

export interface AccessPayload {
  sub: string;
  role: Role;
}

export function signAccessToken(userId: number, role: Role): string {
  return jwt.sign({ role } satisfies Omit<AccessPayload, 'sub'>, config.jwtAccessSecret, {
    subject: String(userId),
    expiresIn: config.accessTokenTtlSeconds,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): AccessPayload {
  return jwt.verify(token, config.jwtAccessSecret, { algorithms: ['HS256'] }) as AccessPayload;
}

export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: config.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  };
}
