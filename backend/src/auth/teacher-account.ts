import { Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { hashPassword, verifyPassword } from '../lib/passwords';

export interface TeacherAccount {
  email: string;
  /** Needed only to create the account. */
  name?: string;
  password: string;
}

/**
 * Creates the teacher account when no account has this email. With `reset`, an existing teacher also gets this
 * name and password wherever they differ, and a new password clears a lockout. Without it, an existing account is
 * left alone (bootstrap's teacher.json, run on every EC2 deploy, never undoes a create-teacher reset).
 */
export async function ensureTeacher(t: TeacherAccount, { reset = false } = {}): Promise<'created' | 'updated' | 'unchanged'> {
  const email = t.email.trim().toLowerCase();
  const name = t.name?.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`"${t.email}" is not a valid email`);
  if (t.password.length < 8 || t.password.length > 72) throw new Error('the password must be 8-72 characters');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    if (!name) throw new Error('a name is needed to create the account');
    await prisma.user.create({ data: { role: 'teacher', email, name, passwordHash: await hashPassword(t.password) } });
    return 'created';
  }
  if (existing.role !== 'teacher') throw new Error(`${email} belongs to a student, not a teacher`);
  if (!reset) return 'unchanged';

  const data: Prisma.UserUpdateInput = {};
  if (name && name !== existing.name) data.name = name;
  if (!(await verifyPassword(t.password, existing.passwordHash))) {
    Object.assign(data, { passwordHash: await hashPassword(t.password), isActive: true, failedLoginCount: 0, lockedUntil: null });
  }
  if (Object.keys(data).length === 0) return 'unchanged';
  await prisma.user.update({ where: { id: existing.id }, data });
  return 'updated';
}

/**
 * For hosts with no shell, such as Render: when TEACHER_EMAIL is set, the server makes sure that teacher exists
 * each time it starts, with TEACHER_PASSWORD as the password. Changing the variable and redeploying resets it.
 * A bad value stops the server, with a message naming the variables to fix.
 */
export async function ensureTeacherFromEnv() {
  const t = config.teacher;
  if (!t) return;
  let result;
  try {
    result = await ensureTeacher(t, { reset: true });
  } catch (e) {
    throw new Error(`TEACHER_EMAIL / TEACHER_NAME / TEACHER_PASSWORD: ${(e as Error).message}`);
  }
  if (result !== 'unchanged') console.log(`Teacher account ${t.email.trim().toLowerCase()} ${result} from TEACHER_EMAIL / TEACHER_PASSWORD.`);
}
