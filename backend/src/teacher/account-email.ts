import { revokeAllForUser } from '../auth/auth.service';
import { config } from '../config';
import { prisma } from '../db';
import { decryptPassword, encryptPassword } from '../lib/credentials';
import { mailConfigured, sendMail } from '../lib/mailer';
import { hashPassword, randomPassword } from '../lib/passwords';

export type AccountEmailStatus =
  | { status: 'sent'; newPassword?: true }
  | { status: 'failed'; error: string }
  | { status: 'no_email' }
  | { status: 'not_configured' };

interface AccountEmail {
  name: string;
  srCode: string;
  password: string;
  subjects: { name: string; section: string }[];
}

/** Plain ASCII text, so it reads the same in every mail app. */
function accountEmailText(a: AccountEmail): string {
  const subjects = a.subjects.length ? a.subjects.map((s) => `- ${s.name} (${s.section})`).join('\n') : '- none yet (your teacher will add them)';
  return [
    `Hello ${a.name},`,
    '',
    'Your JASthinkAboutIT account is ready. You use the same account for all your subjects.',
    '',
    `Sign in: ${config.frontendUrl.replace(/\/+$/, '')}/login (choose Student)`,
    `SR code: ${a.srCode}`,
    `Password: ${a.password}`,
    '',
    'Your subjects:',
    subjects,
    '',
    'Keep this email private. If you think someone else knows your password,',
    'ask your teacher to reset it.',
    '',
  ].join('\n');
}

/**
 * Emails one student their SR code, current password and subjects. A student who chose their own password (or
 * an account from before passwords were kept readable) gets a new temporary one first (reported as newPassword).
 */
export async function sendAccountEmail(studentId: number): Promise<AccountEmailStatus> {
  const s = await prisma.user.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      name: true,
      srCode: true,
      email: true,
      passwordEncrypted: true,
      enrollments: { select: { subject: { select: { name: true } }, section: { select: { name: true } } }, orderBy: { subject: { name: 'asc' } } },
    },
  });
  if (!s?.email || !s.srCode) return { status: 'no_email' };
  if (!mailConfigured()) return { status: 'not_configured' };

  let password = decryptPassword(s.passwordEncrypted);
  let newPassword = false;
  if (password === null) {
    password = randomPassword();
    newPassword = true;
    await prisma.user.update({
      where: { id: s.id },
      data: {
        passwordHash: await hashPassword(password),
        passwordEncrypted: encryptPassword(password),
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    await revokeAllForUser(s.id);
  }

  try {
    await sendMail(
      s.email,
      'Your JASthinkAboutIT account',
      accountEmailText({
        name: s.name,
        srCode: s.srCode,
        password,
        subjects: s.enrollments.map((e) => ({ name: e.subject.name, section: e.section.name })),
      }),
    );
  } catch (err) {
    return { status: 'failed', error: (err as Error).message || 'The mail server refused the message' };
  }
  return newPassword ? { status: 'sent', newPassword: true } : { status: 'sent' };
}

export interface AccountEmailSummary {
  sent: number;
  withoutEmail: number;
  failed: { srCode: string; error: string }[];
  /** Some students have an email address, but email is turned off on the server. */
  notConfigured: boolean;
}

/** Emails several students, three at a time. A failure for one never stops the others. */
export async function sendAccountEmails(students: { id: number; srCode: string }[]): Promise<AccountEmailSummary> {
  const summary: AccountEmailSummary = { sent: 0, withoutEmail: 0, failed: [], notConfigured: false };
  let next = 0;
  const worker = async () => {
    while (next < students.length) {
      const s = students[next++];
      const r = await sendAccountEmail(s.id);
      if (r.status === 'sent') summary.sent++;
      else if (r.status === 'no_email') summary.withoutEmail++;
      else if (r.status === 'not_configured') summary.notConfigured = true;
      else summary.failed.push({ srCode: s.srCode, error: r.error });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, students.length) }, worker));
  summary.failed.sort((a, b) => a.srCode.localeCompare(b.srCode));
  return summary;
}
