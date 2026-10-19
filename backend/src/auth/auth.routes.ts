import { Router, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { body } from '../lib/validate';
import { LoginDto } from './auth.dto';
import { currentUser, requireAuth } from './auth.middleware';
import * as auth from './auth.service';
import { REFRESH_COOKIE, refreshCookieOptions } from './tokens';

const tooMany = { message: 'Too many login attempts. Please wait a minute and try again.', code: 'RATE_LIMITED' };

// Per (IP + account): stops guessing one account's password.
const loginPerAccount = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const who = String(req.body?.srCode ?? req.body?.email ?? '').toLowerCase().slice(0, 255);
    return `${ipKeyGenerator(req.ip ?? '0.0.0.0')}|${who}`;
  },
  message: tooMany,
});

// Per IP overall: generous, because a whole class may log in at once from one school network.
const loginPerIp = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooMany,
});

export function sendSession(res: Response, session: auth.Session) {
  if (session.refreshToken) res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
  res.json({ accessToken: session.accessToken, expiresIn: session.expiresIn, user: session.user });
}

export const authRouter = Router();

authRouter.post('/login', loginPerIp, loginPerAccount, body(LoginDto), async (req, res) => {
  sendSession(res, await auth.login(req.body));
});

authRouter.post('/refresh', async (req, res) => {
  try {
    sendSession(res, await auth.refresh(req.cookies?.[REFRESH_COOKIE]));
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
    throw err;
  }
});

authRouter.post('/logout', async (req, res) => {
  await auth.logout(req.cookies?.[REFRESH_COOKIE]);
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json(currentUser(req));
});
