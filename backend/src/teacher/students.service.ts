import { Prisma } from '@prisma/client';
import { isEmail } from 'class-validator';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { autoSubmitExpired } from '../attempts/grading';
import { revokeAllForUser } from '../auth/auth.service';
import { dbNow, prisma, type Tx } from '../db';
import { decryptPassword, encryptPassword } from '../lib/credentials';
import { safeCell, toCsv } from '../lib/csv';
import { badRequest, conflict, HttpError, notFound } from '../lib/http-error';
import { hashPassword } from '../lib/passwords';
import { SR_CODE_REGEX } from '../lib/sr-code';
import { sendAccountEmail, sendAccountEmails } from './account-email';
import type { CreateStudentDto, EnrollmentDto, UpdateStudentDto } from './teacher.dto';

type Db = Tx | typeof prisma;

interface Enrollment {
  subjectId: number;
  sectionId: number;
}

const studentSelect = {
  id: true,
  srCode: true,
  name: true,
  email: true,
  sectionId: true,
  isActive: true,
  createdAt: true,
  lockedUntil: true,
  mustChangePassword: true,
  lastLoginAt: true,
  section: { select: { name: true } },
  enrollments: {
    select: { subject: { select: { id: true, name: true } }, section: { select: { id: true, name: true } } },
    orderBy: { subjectId: 'asc' as const },
  },
} as const;

type StudentRow = {
  id: number;
  srCode: string | null;
  name: string;
  email: string | null;
  sectionId: number | null;
  isActive: boolean;
  createdAt: Date;
  lockedUntil: Date | null;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  section: { name: string } | null;
  enrollments: { subject: { id: number; name: string }; section: { id: number; name: string } }[];
};

const view = (s: StudentRow) => ({
  id: s.id,
  srCode: s.srCode,
  name: s.name,
  /** Where account emails go (optional). */
  email: s.email,
  /** The student's own (block) section. */
  sectionId: s.sectionId,
  section: s.section?.name ?? null,
  /** Subjects taken, each with the section it is taken in (may differ for irregular students). */
  subjects: s.enrollments.map((e) => ({ id: e.subject.id, name: e.subject.name, sectionId: e.section.id, section: e.section.name })),
  isActive: s.isActive,
  createdAt: s.createdAt,
  lockedUntil: s.lockedUntil,
  /** Still has the password the teacher gave them (they must change it when they sign in). */
  mustChangePassword: s.mustChangePassword,
  lastLoginAt: s.lastLoginAt,
});

export interface StudentFilter {
  sectionId?: number;
  subjectId?: number;
  search?: string;
}

function studentWhere(filter: StudentFilter) {
  const search = filter.search?.trim();
  const and = [];
  // A section filter shows the section's own students plus anyone taking a subject with it.
  if (filter.sectionId) and.push({ OR: [{ sectionId: filter.sectionId }, { enrollments: { some: { sectionId: filter.sectionId } } }] });
  if (filter.subjectId) and.push({ enrollments: { some: { subjectId: filter.subjectId } } });
  if (search) and.push({ OR: [{ srCode: { contains: search } }, { name: { contains: search, mode: 'insensitive' as const } }] });
  return { role: 'student', AND: and };
}

const studentOrder = [{ section: { name: 'asc' as const } }, { name: 'asc' as const }];

export async function listStudents(filter: StudentFilter) {
  const students = await prisma.user.findMany({ where: studentWhere(filter), orderBy: studentOrder, select: studentSelect });
  return students.map(view);
}

/** Open pages ping every minute; seen within this long and still signed in counts as online. */
export const ONLINE_SECONDS = 150;

const ONLINE_SQL = Prisma.sql`
  u.role = 'student' AND u.is_active
  AND u.last_seen_at > now() - interval '150 seconds'
  AND EXISTS (SELECT 1 FROM refresh_tokens rt WHERE rt.user_id = u.id AND rt.revoked_at IS NULL AND rt.expires_at > now())`;

/**
 * The teacher's Online now page: students who are signed in (a session not signed out or expired) and were seen
 * in the last 2.5 minutes, with the quiz each is taking, plus how many of each section's students are online.
 */
export async function onlineNow() {
  await autoSubmitExpired();
  const [students, sections, serverNow] = await Promise.all([
    prisma.$queryRaw<
      {
        id: number;
        sr_code: string;
        name: string;
        section: string | null;
        seen_seconds_ago: number;
        last_login_at: Date | null;
        must_change_password: boolean;
        attempt_id: number | null;
        title: string | null;
      }[]
    >`
      SELECT u.id, u.sr_code, u.name, sec.name AS section,
             floor(extract(epoch FROM now() - u.last_seen_at))::int AS seen_seconds_ago,
             u.last_login_at, u.must_change_password, cur.id AS attempt_id, cur.title
      FROM users u
      LEFT JOIN sections sec ON sec.id = u.section_id
      LEFT JOIN LATERAL (
        SELECT at.id, q.title FROM attempts at
        JOIN assignments asg ON asg.id = at.assignment_id
        JOIN quizzes q ON q.id = asg.quiz_id
        WHERE at.student_id = u.id AND at.status = 'in_progress'
        ORDER BY at.started_at DESC LIMIT 1
      ) cur ON true
      WHERE ${ONLINE_SQL}
      ORDER BY sec.name, u.name`,
    prisma.$queryRaw<{ section: string; students: number; online: number }[]>`
      SELECT sec.name AS section, count(u.id)::int AS students, (count(u.id) FILTER (WHERE ${ONLINE_SQL}))::int AS online
      FROM sections sec
      LEFT JOIN users u ON u.section_id = sec.id AND u.role = 'student' AND u.is_active
      GROUP BY sec.id, sec.name
      ORDER BY sec.name`,
    dbNow(),
  ]);
  return {
    serverNow,
    onlineSeconds: ONLINE_SECONDS,
    sections,
    students: students.map((s) => ({
      id: s.id,
      srCode: s.sr_code,
      name: s.name,
      section: s.section,
      seenSecondsAgo: s.seen_seconds_ago,
      lastLoginAt: s.last_login_at,
      mustChangePassword: s.must_change_password,
      taking: s.attempt_id === null ? null : { attemptId: s.attempt_id, title: s.title! },
    })),
  };
}

/**
 * The students' accounts with their current passwords, as CSV in the import template's columns
 * (SR code, Name, Password, Email, one column per subject with the section it is taken in), so the file can be
 * handed out or imported again. The Password cell is empty for students who chose their own password (and for
 * accounts from before passwords were kept readable) until the teacher resets it.
 */
export async function exportAccountsCsv(filter: StudentFilter): Promise<string> {
  const subjects = await prisma.subject.findMany({ orderBy: { name: 'asc' } });
  const students = await prisma.user.findMany({
    where: studentWhere(filter),
    orderBy: studentOrder,
    select: {
      srCode: true,
      name: true,
      email: true,
      passwordEncrypted: true,
      enrollments: { select: { subjectId: true, section: { select: { name: true } } } },
    },
  });
  return toCsv([
    ['SR code', 'Name', 'Password', 'Email', ...subjects.map((s) => s.name)],
    ...students.map((s) => [
      s.srCode,
      safeCell(s.name),
      // Written exactly: a password changed by formula protection would no longer work.
      decryptPassword(s.passwordEncrypted) ?? '',
      s.email ?? '',
      ...subjects.map((sub) => s.enrollments.find((e) => e.subjectId === sub.id)?.section.name ?? ''),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Enrollment helpers
// ---------------------------------------------------------------------------

/** "sectionId:subjectId" pairs that exist (each section offers these subjects). */
async function offeringKeys(db: Db): Promise<Set<string>> {
  return new Set((await db.sectionSubject.findMany()).map((o) => `${o.sectionId}:${o.subjectId}`));
}

async function subjectsOfSection(db: Db, sectionId: number): Promise<number[]> {
  return (await db.sectionSubject.findMany({ where: { sectionId }, select: { subjectId: true } })).map((s) => s.subjectId);
}

function checkEnrollments(list: EnrollmentDto[], offered: Set<string>): Enrollment[] {
  const seen = new Set<number>();
  for (const e of list) {
    if (seen.has(e.subjectId)) throw badRequest('A subject can be taken in only one section');
    seen.add(e.subjectId);
    if (!offered.has(`${e.sectionId}:${e.subjectId}`)) throw badRequest(`Section ${e.sectionId} does not offer subject ${e.subjectId}`);
  }
  return list.map((e) => ({ subjectId: e.subjectId, sectionId: e.sectionId }));
}

async function assertSection(sectionId: number) {
  if (!(await prisma.section.findUnique({ where: { id: sectionId } }))) throw badRequest('Unknown section');
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Every account has its own email address (the teacher's included, since it is their login). */
async function assertEmailFree(email: string, exceptUserId?: number) {
  const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (owner && owner.id !== exceptUserId) throw conflict(`${email} is already used by another account`, 'DUPLICATE');
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

/** Creates the student, then emails them their account if they have an email address. */
export async function createStudent(dto: CreateStudentDto) {
  await assertSection(dto.sectionId);
  if (await prisma.user.findUnique({ where: { srCode: dto.srCode } })) throw conflict(`SR code ${dto.srCode} already exists`, 'DUPLICATE');
  const email = dto.email ? normalizeEmail(dto.email) : null;
  if (email) await assertEmailFree(email);
  const enrollments =
    dto.enrollments === undefined
      ? (await subjectsOfSection(prisma, dto.sectionId)).map((subjectId) => ({ subjectId, sectionId: dto.sectionId }))
      : checkEnrollments(dto.enrollments, await offeringKeys(prisma));
  const student = await prisma.user.create({
    data: {
      role: 'student',
      srCode: dto.srCode,
      name: dto.name.trim(),
      email,
      sectionId: dto.sectionId,
      passwordHash: await hashPassword(dto.password),
      passwordEncrypted: encryptPassword(dto.password),
      mustChangePassword: true,
      enrollments: { create: enrollments },
    },
    select: studentSelect,
  });
  return { ...view(student), accountEmail: await sendAccountEmail(student.id) };
}

async function getStudentOr404(id: number) {
  const s = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, sectionId: true, enrollments: { select: { subjectId: true, sectionId: true } } },
  });
  if (!s || s.role !== 'student') throw notFound('Student not found');
  return s;
}

export async function updateStudent(id: number, dto: UpdateStudentDto) {
  const current = await getStudentOr404(id);
  if (dto.sectionId) await assertSection(dto.sectionId);
  const email = dto.email ? normalizeEmail(dto.email) : null;
  if (email) await assertEmailFree(email, id);

  const student = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: {
        ...(dto.email !== undefined ? { email } : {}),
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.sectionId !== undefined ? { sectionId: dto.sectionId } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });

    const offered = await offeringKeys(tx);
    let target: Enrollment[] | null = null;
    if (dto.enrollments !== undefined) {
      target = checkEnrollments(dto.enrollments, offered);
    } else if (dto.sectionId !== undefined && dto.sectionId !== current.sectionId) {
      // Moving to another block: subjects taken with the old block move along; irregular ones stay.
      target = current.enrollments.map((e) =>
        e.sectionId === current.sectionId && offered.has(`${dto.sectionId}:${e.subjectId}`) ? { ...e, sectionId: dto.sectionId! } : e,
      );
    }
    if (target) {
      await tx.studentSubject.deleteMany({ where: { studentId: id } });
      if (target.length) await tx.studentSubject.createMany({ data: target.map((e) => ({ studentId: id, ...e })) });
    }
    return tx.user.findUniqueOrThrow({ where: { id }, select: studentSelect });
  });

  if (dto.isActive === false) await revokeAllForUser(id);
  return view(student);
}

/**
 * Sets a new temporary password (the student must change it when they sign in), signs them out everywhere, and
 * emails them the new one if they have an address.
 */
export async function resetPassword(id: number, password: string) {
  await getStudentOr404(id);
  await prisma.user.update({
    where: { id },
    data: {
      passwordHash: await hashPassword(password),
      passwordEncrypted: encryptPassword(password),
      mustChangePassword: true,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  await revokeAllForUser(id);
  return { accountEmail: await sendAccountEmail(id) };
}

/** The "Send account email" button: the student's current password (or a new one for an old account). */
export async function emailAccount(id: number) {
  await getStudentOr404(id);
  const result = await sendAccountEmail(id);
  if (result.status === 'no_email') throw badRequest('This student has no email address. Add one first.');
  if (result.status === 'not_configured') throw conflict('Email is not set up on the server (the SMTP settings in .env).', 'MAIL_NOT_CONFIGURED');
  if (result.status === 'failed') throw new HttpError(502, `Could not send the email: ${result.error}`, 'MAIL_FAILED');
  return result;
}

// ---------------------------------------------------------------------------
// Import (CSV or the Excel template)
// ---------------------------------------------------------------------------

interface ImportRowError {
  line: number;
  srCode?: string;
  error: string;
}

interface RawTable {
  headers: string[];
  rows: { line: number; values: string[] }[];
}

/** Header/name comparison: lower case, letters and digits only ("SR code" -> "srcode"). */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const NOT_TAKEN = new Set(['', '-', 'none', 'no', 'na', 'n/a', 'x']);

/** "BCpET3101", "bcpet 3101", "Section BCpET3101" or just "3101". */
function matchSection(value: string, sections: { id: number; name: string }[]): number | undefined {
  const v = norm(value.replace(/^section\s*/i, ''));
  if (!v) return undefined;
  const exact = sections.find((s) => norm(s.name) === v);
  if (exact) return exact.id;
  const bySuffix = sections.filter((s) => norm(s.name).endsWith(v));
  return bySuffix.length === 1 ? bySuffix[0].id : undefined;
}

/** A subject by full or partial name ("Database Design", "database", "CpET343"). */
function matchSubject(value: string, subjects: { id: number; name: string }[]): number | undefined {
  const v = norm(value);
  if (!v) return undefined;
  const exact = subjects.find((s) => norm(s.name) === v);
  if (exact) return exact.id;
  const partial = subjects.filter((s) => norm(s.name).includes(v));
  return partial.length === 1 ? partial[0].id : undefined;
}

function readCsv(csv: string): RawTable {
  let records: string[][];
  try {
    records = parse(csv.replace(/^﻿/, ''), { skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch (e) {
    throw badRequest(`Could not read CSV: ${(e as Error).message}`);
  }
  if (records.length < 2) throw badRequest('The file has no student rows');
  const [headers, ...rows] = records;
  return { headers, rows: rows.map((values, i) => ({ line: i + 2, values })) };
}

async function readXlsx(base64: string): Promise<RawTable> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(base64, 'base64') as unknown as ArrayBuffer);
  } catch {
    throw badRequest('Could not read the Excel file. Save it as .xlsx (Excel Workbook) and try again.');
  }
  const ws = wb.getWorksheet('Students') ?? wb.worksheets[0];
  if (!ws) throw badRequest('The Excel file has no sheets');
  const width = ws.getRow(1).cellCount;
  const text = (row: ExcelJS.Row, c: number) => String(row.getCell(c).text ?? '').trim();
  const headers = Array.from({ length: width }, (_, i) => text(ws.getRow(1), i + 1));
  const rows: RawTable['rows'] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const values = headers.map((_, i) => text(row, i + 1));
    if (values.some((v) => v !== '')) rows.push({ line: r, values });
  }
  if (rows.length === 0) throw badRequest('The Excel file has no student rows (fill in the "Students" sheet from row 2)');
  return { headers, rows };
}

/**
 * Columns (header row required, any order, case-insensitive):
 *   SR code, Name, Password, optional Email, and either
 *   - one column per subject holding the section the student takes it in (blank = not taken), as in the Excel template, or
 *   - Section [+ Subjects, separated by ";", blank = both].
 * All-or-nothing: if any row is invalid nothing is created. SR codes that already exist are skipped.
 * Afterwards every new student with an email address is emailed their account; failures are reported, not fatal.
 */
export async function importStudents(input: { csv?: string; xlsxBase64?: string }) {
  if (!!input.csv === !!input.xlsxBase64) throw badRequest('Send either a CSV file or an Excel file');
  const table = input.xlsxBase64 ? await readXlsx(input.xlsxBase64) : readCsv(input.csv!);
  if (table.rows.length > 2000) throw badRequest('At most 2000 students per import');

  const sections = await prisma.section.findMany({ orderBy: { name: 'asc' } });
  const subjects = await prisma.subject.findMany({ orderBy: { name: 'asc' } });
  const offered = await offeringKeys(prisma);

  // Map header positions.
  const col: Record<string, number> = {};
  const subjectCols: { index: number; subjectId: number; name: string }[] = [];
  table.headers.forEach((h, i) => {
    const key = norm(h);
    if (['srcode', 'name', 'section', 'password', 'subjects', 'email'].includes(key)) col[key] = i;
    else {
      const sid = matchSubject(h, subjects);
      if (sid && !subjectCols.some((c) => c.subjectId === sid)) subjectCols.push({ index: i, subjectId: sid, name: subjects.find((s) => s.id === sid)!.name });
    }
  });
  for (const required of ['srcode', 'name', 'password']) {
    if (col[required] === undefined) {
      throw badRequest(`Missing column "${required === 'srcode' ? 'SR code' : required}". Download the Excel template to see the expected columns.`);
    }
  }
  if (!subjectCols.length && col.section === undefined) {
    throw badRequest('Add a "Section" column, or one column per subject with the section the student takes it in.');
  }

  const cell = (values: string[], key: string) => (col[key] === undefined ? '' : (values[col[key]] ?? '').trim());
  const existing = new Set(
    (
      await prisma.user.findMany({
        where: { srCode: { in: table.rows.map((r) => cell(r.values, 'srcode')) } },
        select: { srCode: true },
      })
    ).map((u) => u.srCode),
  );
  // Email address -> SR code of the account already using it (the teacher's login counts too).
  const emailOwners = new Map(
    (
      await prisma.user.findMany({
        where: { email: { in: table.rows.map((r) => normalizeEmail(cell(r.values, 'email'))).filter(Boolean) } },
        select: { email: true, srCode: true },
      })
    ).map((u) => [u.email!, u.srCode]),
  );

  const errors: ImportRowError[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const seenEmails = new Set<string>();
  const toCreate: { srCode: string; name: string; email: string | null; sectionId: number; password: string; enrollments: Enrollment[] }[] = [];

  for (const { line, values } of table.rows) {
    const srCode = cell(values, 'srcode');
    const name = cell(values, 'name');
    const password = cell(values, 'password');
    const email = normalizeEmail(cell(values, 'email')) || null;
    const fail = (error: string) => errors.push({ line, srCode, error });

    if (!SR_CODE_REGEX.test(srCode)) { fail('SR code must look like 23-12345'); continue; }
    if (seen.has(srCode)) { fail('Duplicate SR code in file'); continue; }
    seen.add(srCode);
    if (!name) { fail('Name is required'); continue; }
    if (name.length > 150) { fail('Name is too long'); continue; }
    if (password.length < 6 || password.length > 72) { fail('Password must be 6-72 characters'); continue; }
    if (email) {
      if (!isEmail(email) || email.length > 255) { fail(`"${email}" is not a valid email address`); continue; }
      if (seenEmails.has(email)) { fail(`Email ${email} is used twice in this file`); continue; }
      seenEmails.add(email);
      // A student already on the server keeps their own address (re-importing an export is fine).
      const owner = emailOwners.get(email);
      if (owner !== undefined && owner !== srCode) { fail(`Email ${email} is already used by another account`); continue; }
    }

    const sectionCell = cell(values, 'section');
    let home = sectionCell ? matchSection(sectionCell, sections) : undefined;
    if (sectionCell && !home) { fail(`Unknown section "${sectionCell}" (use ${sections.map((s) => s.name).join(', ')})`); continue; }

    let enrollments: Enrollment[] = [];
    let rowError: string | null = null;
    if (subjectCols.length) {
      for (const sc of subjectCols) {
        const v = (values[sc.index] ?? '').trim();
        if (NOT_TAKEN.has(v.toLowerCase())) continue;
        const sectionId = matchSection(v, sections);
        if (!sectionId) { rowError = `Unknown section "${v}" under ${sc.name}`; break; }
        if (!offered.has(`${sectionId}:${sc.subjectId}`)) { rowError = `${sc.name} is not offered in that section`; break; }
        enrollments.push({ subjectId: sc.subjectId, sectionId });
      }
      home ??= enrollments[0]?.sectionId;
      if (!rowError && !home) rowError = 'Choose a section under at least one subject';
    } else {
      if (!home) { fail('Section is required'); continue; }
      const tokens = cell(values, 'subjects').split(/[;|]/).map((t) => t.trim()).filter(Boolean);
      const all = tokens.length === 0 || tokens.some((t) => ['both', 'all'].includes(t.toLowerCase()));
      const ids: number[] = [];
      if (all) ids.push(...subjects.filter((s) => offered.has(`${home}:${s.id}`)).map((s) => s.id));
      else {
        for (const t of tokens) {
          const sid = matchSubject(t, subjects);
          if (!sid) { rowError = `Unknown subject "${t}"`; break; }
          if (!offered.has(`${home}:${sid}`)) { rowError = 'Subject not offered to that section'; break; }
          if (!ids.includes(sid)) ids.push(sid);
        }
      }
      enrollments = ids.map((subjectId) => ({ subjectId, sectionId: home! }));
    }
    if (rowError) { fail(rowError); continue; }
    if (existing.has(srCode)) { skipped.push(srCode); continue; }
    toCreate.push({ srCode, name, email, sectionId: home!, password, enrollments });
  }

  if (errors.length) throw badRequest(`${errors.length} row(s) have problems. Nothing was imported.`, errors);

  const hashed = await Promise.all(toCreate.map(async (s) => ({ ...s, passwordHash: await hashPassword(s.password) })));
  const created = await prisma.$transaction(
    async (tx) => {
      const out: { id: number; srCode: string }[] = [];
      for (const s of hashed) {
        const user = await tx.user.create({
          data: {
            role: 'student',
            srCode: s.srCode,
            name: s.name,
            email: s.email,
            sectionId: s.sectionId,
            passwordHash: s.passwordHash,
            passwordEncrypted: encryptPassword(s.password),
            mustChangePassword: true,
            enrollments: { create: s.enrollments },
          },
          select: { id: true },
        });
        out.push({ id: user.id, srCode: s.srCode });
      }
      return out;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  return { created: created.length, skipped, emails: await sendAccountEmails(created) };
}

// ---------------------------------------------------------------------------
// Excel template
// ---------------------------------------------------------------------------

const NAVY = 'FF232F3E';
const ORANGE = 'FFFF9900';

/** A ready-to-fill workbook: "Students" sheet with dropdowns, plus an "Instructions" sheet. */
export async function studentsTemplate(): Promise<Buffer> {
  const sections = await prisma.section.findMany({ orderBy: { name: 'asc' } });
  const subjects = await prisma.subject.findMany({ orderBy: { name: 'asc' } });
  const sectionList = `"${sections.map((s) => s.name).join(',')}"`;
  const ROWS = 1000;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'JASthinkAboutIT';
  wb.created = new Date();

  const ws = wb.addWorksheet('Students', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'SR code', key: 'sr', width: 14, style: { numFmt: '@' } },
    { header: 'Name', key: 'name', width: 34 },
    { header: 'Password', key: 'password', width: 16, style: { numFmt: '@' } },
    { header: 'Email', key: 'email', width: 30 },
    ...subjects.map((s, i) => ({ header: s.name, key: `subject${i}`, width: Math.max(18, s.name.length + 4) })),
  ];
  const FIRST_SUBJECT_COL = 5;
  const header = ws.getRow(1);
  header.height = 24;
  header.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    c.alignment = { vertical: 'middle' };
    c.border = { bottom: { style: 'medium', color: { argb: ORANGE } } };
  });
  header.getCell(1).note = 'Format NN-NNNNN, e.g. 23-12345';
  header.getCell(4).note = 'Optional. The student is emailed their SR code and password.';
  subjects.forEach((s, i) => {
    header.getCell(FIRST_SUBJECT_COL + i).note = `Section the student takes ${s.name} in. Leave blank if they do not take it.`;
  });

  for (let r = 2; r <= ROWS + 1; r++) {
    ws.getCell(r, 1).dataValidation = {
      type: 'textLength', operator: 'equal', formulae: [8], allowBlank: true, showErrorMessage: true,
      errorTitle: 'SR code', error: 'Use the format NN-NNNNN, for example 23-12345.',
    };
    ws.getCell(r, 3).dataValidation = {
      type: 'textLength', operator: 'between', formulae: [6, 72], allowBlank: true, showErrorMessage: true,
      errorTitle: 'Password', error: 'The password must be 6 to 72 characters.',
    };
    subjects.forEach((_, i) => {
      ws.getCell(r, FIRST_SUBJECT_COL + i).dataValidation = {
        type: 'list', allowBlank: true, formulae: [sectionList], showErrorMessage: true,
        errorTitle: 'Section', error: 'Pick a section from the list, or leave it blank if the student does not take this subject.',
      };
    });
  }

  // Instructions
  const help = wb.addWorksheet('Instructions');
  help.getColumn(1).width = 110;
  const lines: [string, Partial<ExcelJS.Font>?][] = [
    ['How to fill in the Students sheet', { bold: true, size: 14 }],
    [''],
    ['1. One row per student, starting on row 2. Do not change the header row.'],
    ['2. SR code: format NN-NNNNN, for example 23-12345.'],
    ['3. Password: the student\'s first password (6-72 characters). You can reset it later on the Students page.'],
    ['4. Email (optional): the student is emailed their SR code, password and subjects. Each student needs their own address.'],
    [`5. Subject columns (${subjects.map((s) => s.name).join(', ')}): choose the section the student takes that subject in.`],
    ['   Leave the cell blank if the student does not take that subject.'],
    ['   Irregular students take one subject in one section and the other subject in another section: same row, same account.'],
    ['6. The student\'s own section is the first section in their row.'],
    ['7. Save as .xlsx and upload it on Students > Import. If any row has a problem nothing is imported and every problem is listed.'],
    ['   SR codes that already exist are skipped (change their subjects on the Students page instead).'],
    [''],
    ['Examples', { bold: true, size: 12 }],
  ];
  lines.forEach(([t, font]) => {
    const row = help.addRow([t]);
    if (font) row.font = font;
  });
  const exHeader = help.addRow(['SR code | Name | Password | Email | ' + subjects.map((s) => s.name).join(' | ')]);
  exHeader.font = { bold: true };
  const [s1, s2] = [sections[0]?.name ?? '', sections[1]?.name ?? sections[0]?.name ?? ''];
  help.addRow([`23-12345 | Dela Cruz, Juan | juan2026 | juan@example.com | ${subjects.map(() => s1).join(' | ')}      (takes every subject with ${s1})`]);
  help.addRow([`23-12346 | Santos, Maria | maria2026 |  | ${s1}${subjects.length > 1 ? ' | ' : ''}${subjects.slice(1).map(() => '').join(' | ')}      (only the first subject, no email)`]);
  if (subjects.length > 1) {
    help.addRow([`23-12347 | Rizal, Jose | jose2026 | jose@example.com | ${s1} | ${s2}      (irregular: different section per subject, one account)`]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
