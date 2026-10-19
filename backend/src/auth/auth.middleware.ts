import type { NextFunction, Request, Response } from 'express';
import { forbidden, HttpError, unauthorized } from '../lib/http-error';
import { loadAuthUser, touchLastSeen } from './auth.service';
import type { AuthUser, Role } from './auth.types';
import { verifyAccessToken } from './tokens';

/** Verifies the Bearer access token and loads the user fresh from the DB (so deactivation takes effect immediately). */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  let userId: number;
  try {
    userId = Number(verifyAccessToken(header.slice(7)).sub);
  } catch {
    throw unauthorized('Access token expired or invalid');
  }
  const user = await loadAuthUser(userId);
  if (!user) throw unauthorized('Account not found or deactivated');
  await touchLastSeen(user.id);
  req.user = user;
  next();
}

export function requireRole(role: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (req.user.role !== role) throw forbidden(`This endpoint is for ${role}s only`);
    if (role === 'student' && req.user.sectionId === null) throw forbidden('Student has no section');
    // Every student and teacher router goes through here; /api/account (where the password is changed) does not.
    if (req.user.mustChangePassword) throw new HttpError(403, 'Choose your own password before you continue.', 'PASSWORD_CHANGE_REQUIRED');
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
