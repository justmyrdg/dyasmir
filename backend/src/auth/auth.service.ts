import { config } from '../config';
import { prisma } from '../db';
import { HttpError, unauthorized } from '../lib/http-error';
import { DUMMY_HASH, verifyPassword } from '../lib/passwords';
import type { LoginDto } from './auth.dto';
import type { AuthUser, Role } from './auth.types';
import { hashRefreshToken, newRefreshToken, signAccessToken } from './tokens';

const INVALID = 'Invalid login or password';
// A refresh token used again within this window (e.g. two tabs refreshing at once) is not treated as theft.
const REUSE_GRACE_SECONDS = 30;

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
  /** Present when a new refresh cookie must be set. */
  refreshToken?: string;
}

const userSelect = {
  id: true,
  role: true,
  name: true,
  srCode: true,
  email: true,
  sectionId: true,
  isActive: true,
  section: { select: { name: true } },
} as const;

type SelectedUser = {
  id: number;
  role: string;
  name: string;
  srCode: string | null;
  email: string | null;
  sectionId: number | null;
  section: { name: string } | null;
};

export function toAuthUser(u: SelectedUser): AuthUser {
  return {
    id: u.id,
    role: u.role as Role,
    name: u.name,
    srCode: u.srCode,
    email: u.email,
    sectionId: u.sectionId,
    sectionName: u.section?.name ?? null,
  };
}

export async function loadAuthUser(id: number): Promise<AuthUser | null> {
  const u = await prisma.user.findUnique({ where: { id }, select: userSelect });
  if (!u || !u.isActive) return null;
  return toAuthUser(u);
}

async function issueSession(user: AuthUser): Promise<Session> {
  const { token, hash } = newRefreshToken();
  await prisma.$executeRaw`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
    VALUES (${user.id}, ${hash}, now() + make_interval(days => ${config.refreshTokenTtlDays}::int))`;
  return {
    accessToken: signAccessToken(user.id, user.role),
    expiresIn: config.accessTokenTtlSeconds,
    user,
    refreshToken: token,
  };
}

export async function login(dto: LoginDto): Promise<Session> {
  const user = dto.srCode
    ? await prisma.user.findUnique({ where: { srCode: dto.srCode }, select: { ...userSelect, passwordHash: true } })
    : await prisma.user.findUnique({ where: { email: dto.email!.trim().toLowerCase() }, select: { ...userSelect, passwordHash: true } });

  const expectedRole: Role = dto.srCode ? 'student' : 'teacher';
  if (!user || user.role !== expectedRole) {
    await verifyPassword(dto.password, DUMMY_HASH);
    throw new HttpError(401, INVALID, 'INVALID_CREDENTIALS');
  }

  const [lock] = await prisma.$queryRaw<{ locked: boolean; minutes: number }[]>`
    SELECT coalesce(locked_until > now(), false) AS locked,
           coalesce(ceil(extract(epoch FROM (locked_until - now())) / 60), 0)::int AS minutes
    FROM users WHERE id = ${user.id}`;
  if (lock.locked) {
    throw new HttpError(423, `Too many failed attempts. Try again in ${lock.minutes} minute(s).`, 'ACCOUNT_LOCKED');
  }

  const ok = await verifyPassword(dto.password, user.passwordHash);
  if (!ok) {
    const [after] = await prisma.$queryRaw<{ locked: boolean }[]>`
      UPDATE users SET
        locked_until = CASE WHEN failed_login_count + 1 >= ${config.loginMaxFailedAttempts}
                            THEN now() + make_interval(mins => ${config.loginLockMinutes}::int) ELSE locked_until END,
        failed_login_count = CASE WHEN failed_login_count + 1 >= ${config.loginMaxFailedAttempts}
                                  THEN 0 ELSE failed_login_count + 1 END
      WHERE id = ${user.id}
      RETURNING coalesce(locked_until > now(), false) AS locked`;
    if (after?.locked) {
      throw new HttpError(423, `Too many failed attempts. Try again in ${config.loginLockMinutes} minute(s).`, 'ACCOUNT_LOCKED');
    }
    throw new HttpError(401, INVALID, 'INVALID_CREDENTIALS');
  }

  if (!user.isActive) throw new HttpError(403, 'This account has been deactivated. Ask your teacher.', 'ACCOUNT_INACTIVE');

  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
  return issueSession(toAuthUser(user));
}

export async function refresh(token: string | undefined): Promise<Session> {
  if (!token) throw unauthorized('No session');
  const hash = hashRefreshToken(token);

  const [row] = await prisma.$queryRaw<
    { id: number; user_id: number; expired: boolean; revoked: boolean; within_grace: boolean }[]
  >`
    SELECT id, user_id,
           expires_at <= now() AS expired,
           revoked_at IS NOT NULL AS revoked,
           coalesce(revoked_at > now() - make_interval(secs => ${REUSE_GRACE_SECONDS}::int), false) AS within_grace
    FROM refresh_tokens WHERE token_hash = ${hash}`;

  if (!row || row.expired) throw unauthorized('Session expired');

  const user = await loadAuthUser(row.user_id);
  if (!user) throw unauthorized('Session expired');

  if (row.revoked) {
    if (row.within_grace) {
      // Concurrent refresh from another tab: the browser already holds the newer cookie.
      return { accessToken: signAccessToken(user.id, user.role), expiresIn: config.accessTokenTtlSeconds, user };
    }
    // An old token was replayed: assume it was stolen and end every session of this user.
    await revokeAllForUser(user.id);
    throw unauthorized('Session expired');
  }

  // Rotate: the presented token is revoked and replaced.
  const revoked = await prisma.$executeRaw`
    UPDATE refresh_tokens SET revoked_at = now() WHERE id = ${row.id} AND revoked_at IS NULL`;
  if (revoked === 0) {
    return { accessToken: signAccessToken(user.id, user.role), expiresIn: config.accessTokenTtlSeconds, user };
  }
  return issueSession(user);
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  await prisma.$executeRaw`
    UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = ${hashRefreshToken(token)} AND revoked_at IS NULL`;
}

export async function revokeAllForUser(userId: number): Promise<void> {
  await prisma.$executeRaw`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
}
