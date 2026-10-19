import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { body } from '../lib/validate';
import { ChangePasswordDto } from './auth.dto';
import { currentUser, requireAuth } from './auth.middleware';
import { sendSession } from './auth.routes';
import * as auth from './auth.service';

/**
 * The signed-in user's own account. No requireRole here, so a student who still has a temporary password can use
 * it (every other router answers 403 PASSWORD_CHANGE_REQUIRED). Not under /api/auth, because the frontend sends
 * its Bearer token to every /api path except /api/auth.
 */
export const accountRouter = Router();
accountRouter.use(requireAuth);

/** Called every minute by open pages so the teacher sees who is online (requireAuth records it). */
accountRouter.post('/ping', (_req, res) => {
  res.status(204).end();
});

// Someone holding a stolen session should not be able to guess the current password quickly.
const changeLimit = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${currentUser(req).id}`,
  message: { message: 'Too many tries. Please wait a minute and try again.', code: 'RATE_LIMITED' },
});

/** { currentPassword, newPassword }: replies with a new session (and refresh cookie); other sessions end. */
accountRouter.post('/password', changeLimit, body(ChangePasswordDto), async (req, res) => {
  sendSession(res, await auth.changePassword(currentUser(req).id, req.body.currentPassword, req.body.newPassword));
});
