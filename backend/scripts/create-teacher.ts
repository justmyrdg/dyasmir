/**
 * Creates (or updates the password of) a teacher account.
 *
 *   npm run create-teacher -- --email teacher@school.edu --name "Ms. Santos"
 *   (prompts for the password; or pass --password / set TEACHER_PASSWORD for non-interactive use)
 */
import '../src/config';
import { createInterface } from 'node:readline';
import { prisma } from '../src/db';
import { hashPassword } from '../src/lib/passwords';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Mask typed characters.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stdout.write(s);
        else if (s === '\r\n' || s === '\n') process.stdout.write(s);
        else process.stdout.write('*');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const email = (arg('email') ?? (await prompt('Teacher email: '))).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is required');

  const existing = await prisma.user.findUnique({ where: { email } });
  const name = arg('name') ?? existing?.name ?? (await prompt('Full name: '));
  if (!name) throw new Error('Name is required');

  let password = arg('password') ?? process.env.TEACHER_PASSWORD;
  if (!password) {
    password = await prompt('Password (min 8 chars): ', true);
    const again = await prompt('Repeat password: ', true);
    if (password !== again) throw new Error('Passwords do not match');
  }
  if (password.length < 8 || password.length > 72) throw new Error('Password must be 8-72 characters');

  const passwordHash = await hashPassword(password);
  if (existing) {
    if (existing.role !== 'teacher') throw new Error(`${email} belongs to a non-teacher account`);
    await prisma.user.update({
      where: { id: existing.id },
      data: { name, passwordHash, isActive: true, failedLoginCount: 0, lockedUntil: null },
    });
    console.log(`Updated teacher ${email}.`);
  } else {
    await prisma.user.create({ data: { role: 'teacher', email, name, passwordHash } });
    console.log(`Created teacher ${email}. Log in on the Teacher tab of the login page.`);
  }
}

main()
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
