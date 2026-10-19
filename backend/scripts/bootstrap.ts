/**
 * Fills the database from the private seed data in data/seed/. That folder is gitignored, so the answer keys and
 * the password stay out of the repository, but it is inside the project folder you copy to the server.
 * deploy/setup-ec2.sh runs this on every deploy, after the migrations. Running it again changes nothing:
 *
 *   data/seed/teacher.json   { "email": "...", "name": "...", "password": "..." }
 *                            creates this teacher account if no account has that email (an existing one is left alone)
 *   data/seed/*.json         every other file: quizzes in the import format (data/quizzes.sample.json);
 *                            a quiz whose title already exists in its subject is skipped
 *
 *   npm run bootstrap                  # or: node dist/scripts/bootstrap.js
 *   npm run export:quizzes             # refresh data/seed/quizzes.json from this database
 */
import '../src/config';
import fs from 'node:fs';
import path from 'node:path';
import { ensureTeacher } from '../src/auth/teacher-account';
import { prisma } from '../src/db';
import { seedQuizFile } from './lib/seed';

const TEACHER_FILE = 'teacher.json';

async function main() {
  const dir = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data/seed');
  if (!fs.existsSync(dir)) {
    console.log(`No seed data: ${path.relative(process.cwd(), dir)} does not exist.`);
    return;
  }

  const teacherFile = path.join(dir, TEACHER_FILE);
  if (fs.existsSync(teacherFile)) {
    const t = JSON.parse(fs.readFileSync(teacherFile, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
    const field = (k: string) => (typeof t[k] === 'string' ? (t[k] as string) : '');
    const email = field('email').trim().toLowerCase();
    let result;
    try {
      result = await ensureTeacher({ email, name: field('name'), password: field('password') });
    } catch (e) {
      throw new Error(`${TEACHER_FILE}: ${(e as Error).message}`);
    }
    console.log(result === 'created' ? `create  teacher ${email}` : `skip    teacher ${email} (already exists; reset the password with create-teacher)`);
  } else {
    console.log(`No ${TEACHER_FILE} in the seed folder, so no teacher account was created.`);
  }

  const quizFiles = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json') && f !== TEACHER_FILE)
    .sort();
  for (const f of quizFiles) {
    console.log(`-- ${f}`);
    try {
      await seedQuizFile(path.join(dir, f));
    } catch (e) {
      throw new Error(`${f}: ${(e as Error).message}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
