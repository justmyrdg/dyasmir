import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { autoSubmitExpired, DEADLINE_SQL, gradeAttempt, TOTAL_POINTS_SQL } from '../attempts/grading';
import { COUNTED_EVENT_TYPES } from '../attempts/security';
import { prisma } from '../db';
import { badRequest, conflict, notFound } from '../lib/http-error';

export const MANILA_TZ = 'Asia/Manila';

export function formatManila(d: Date | null): string {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: MANILA_TZ,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(d);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function dashboard() {
  await autoSubmitExpired();

  const stats = await prisma.$queryRaw<
    {
      section_id: number;
      section: string;
      subject_id: number;
      subject: string;
      section_students: number;
      students: number;
      submitted: number;
      in_progress: number;
      avg_score: number | null;
      avg_percent: number | null;
    }[]
  >`
    SELECT sec.id AS section_id, sec.name AS section, sub.id AS subject_id, sub.name AS subject,
           (SELECT count(DISTINCT u.id)::int FROM users u JOIN student_subjects en ON en.student_id = u.id
             WHERE en.section_id = sec.id AND u.is_active) AS section_students,
           (SELECT count(*)::int FROM users u JOIN student_subjects en ON en.student_id = u.id
             WHERE en.section_id = sec.id AND en.subject_id = sub.id AND u.is_active) AS students,
           count(at.id) FILTER (WHERE at.status = 'submitted')::int AS submitted,
           count(at.id) FILTER (WHERE at.status = 'in_progress')::int AS in_progress,
           (avg(at.score) FILTER (WHERE at.status = 'submitted'))::float8 AS avg_score,
           (avg(at.score::float8 * 100 / NULLIF(${TOTAL_POINTS_SQL}, 0)) FILTER (WHERE at.status = 'submitted'))::float8 AS avg_percent
    FROM section_subjects ss
    JOIN sections sec ON sec.id = ss.section_id
    JOIN subjects sub ON sub.id = ss.subject_id
    LEFT JOIN quizzes q ON q.subject_id = sub.id
    LEFT JOIN assignments asg ON asg.quiz_id = q.id AND asg.section_id = sec.id
    LEFT JOIN attempts at ON at.assignment_id = asg.id
    GROUP BY sec.id, sec.name, sub.id, sub.name
    ORDER BY sec.name, sub.name`;

  const upcoming = await prisma.$queryRaw<
    {
      assignment_id: number;
      quiz_id: number;
      title: string;
      subject: string;
      section: string;
      start_at: Date;
      due_at: Date;
      state: 'scheduled' | 'open';
      students: number;
      submitted: number;
      in_progress: number;
      now: Date;
    }[]
  >`
    SELECT asg.id AS assignment_id, q.id AS quiz_id, q.title, sub.name AS subject, sec.name AS section,
           asg.start_at, asg.due_at,
           CASE WHEN now() < asg.start_at THEN 'scheduled' ELSE 'open' END AS state,
           (SELECT count(*)::int FROM users u JOIN student_subjects en ON en.student_id = u.id
             WHERE en.section_id = sec.id AND en.subject_id = q.subject_id AND u.is_active) AS students,
           (SELECT count(*)::int FROM attempts at WHERE at.assignment_id = asg.id AND at.status = 'submitted') AS submitted,
           (SELECT count(*)::int FROM attempts at WHERE at.assignment_id = asg.id AND at.status = 'in_progress') AS in_progress,
           now() AS now
    FROM assignments asg
    JOIN quizzes q ON q.id = asg.quiz_id
    JOIN subjects sub ON sub.id = q.subject_id
    JOIN sections sec ON sec.id = asg.section_id
    WHERE asg.due_at > now()
    ORDER BY asg.start_at, sec.name
    LIMIT 50`;

  return {
    serverNow: upcoming[0]?.now ?? new Date(),
    stats: stats.map((s) => ({
      sectionId: s.section_id,
      section: s.section,
      subjectId: s.subject_id,
      subject: s.subject,
      sectionStudents: s.section_students,
      /** Active students of this section enrolled in this subject. */
      students: s.students,
      submitted: s.submitted,
      inProgress: s.in_progress,
      averageScore: s.avg_score === null ? null : Math.round(s.avg_score * 100) / 100,
      averagePercent: s.avg_percent === null ? null : Math.round(s.avg_percent * 10) / 10,
    })),
    upcoming: upcoming.map((u) => ({
      assignmentId: u.assignment_id,
      quizId: u.quiz_id,
      title: u.title,
      subject: u.subject,
      section: u.section,
      startAt: u.start_at,
      dueAt: u.due_at,
      state: u.state,
      students: u.students,
      submitted: u.submitted,
      inProgress: u.in_progress,
    })),
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ResultsFilter {
  sectionId?: number;
  subjectId?: number;
  quizId?: number;
}

export interface ResultRow {
  studentId: number;
  srCode: string;
  name: string;
  section: string;
  quizId: number;
  quiz: string;
  subject: string;
  status: 'not_started' | 'in_progress' | 'submitted';
  score: number | null;
  /** What this student's quiz is out of (their own pick of items); null before they start if that isn't known yet. */
  totalPoints: number | null;
  attemptId: number | null;
  startedAt: Date | null;
  submittedAt: Date | null;
  isActive: boolean;
  /** Exam-security events recorded for this attempt (all kinds). */
  flags: number;
  /** Times the student left the exam / pressed a screenshot or print key (the auto-submit counter). */
  violations: number;
}

export async function results(filter: ResultsFilter): Promise<ResultRow[]> {
  await autoSubmitExpired();
  const where: Prisma.Sql[] = [
    Prisma.sql`u.role = 'student'`,
    // Active students enrolled in the quiz's subject in this assignment's section; anyone with an attempt always shows.
    Prisma.sql`(u.is_active OR at.id IS NOT NULL)`,
  ];
  if (filter.sectionId) where.push(Prisma.sql`asg.section_id = ${filter.sectionId}`);
  if (filter.subjectId) where.push(Prisma.sql`q.subject_id = ${filter.subjectId}`);
  if (filter.quizId) where.push(Prisma.sql`q.id = ${filter.quizId}`);

  const rows = await prisma.$queryRaw<
    {
      student_id: number;
      sr_code: string;
      name: string;
      section: string;
      quiz_id: number;
      quiz: string;
      subject: string;
      total_points: number | null;
      attempt_id: number | null;
      status: 'in_progress' | 'submitted' | null;
      score: number | null;
      started_at: Date | null;
      submitted_at: Date | null;
      is_active: boolean;
      flags: number;
      violations: number;
    }[]
  >`
    SELECT u.id AS student_id, u.sr_code, u.name, sec.name AS section, u.is_active,
           q.id AS quiz_id, q.title AS quiz, sub.name AS subject, ${TOTAL_POINTS_SQL} AS total_points,
           at.id AS attempt_id, at.status, at.score, at.started_at, at.submitted_at,
           (SELECT count(*)::int FROM attempt_events e WHERE e.attempt_id = at.id) AS flags,
           (SELECT count(*)::int FROM attempt_events e
             WHERE e.attempt_id = at.id AND e.type = ANY(${COUNTED_EVENT_TYPES}::text[])) AS violations
    FROM assignments asg
    JOIN quizzes q ON q.id = asg.quiz_id
    JOIN subjects sub ON sub.id = q.subject_id
    JOIN sections sec ON sec.id = asg.section_id
    JOIN users u ON u.role = 'student' AND (
           EXISTS (SELECT 1 FROM student_subjects en
                   WHERE en.student_id = u.id AND en.subject_id = q.subject_id AND en.section_id = asg.section_id)
           OR EXISTS (SELECT 1 FROM attempts a2 WHERE a2.assignment_id = asg.id AND a2.student_id = u.id))
    LEFT JOIN attempts at ON at.assignment_id = asg.id AND at.student_id = u.id
    WHERE ${Prisma.join(where, ' AND ')}
    ORDER BY sub.name, q.title, sec.name, u.name`;

  return rows.map((r) => ({
    studentId: r.student_id,
    srCode: r.sr_code,
    name: r.name,
    section: r.section,
    quizId: r.quiz_id,
    quiz: r.quiz,
    subject: r.subject,
    status: r.status ?? 'not_started',
    score: r.status === 'submitted' ? r.score : null,
    totalPoints: r.total_points,
    attemptId: r.attempt_id,
    startedAt: r.started_at,
    submittedAt: r.submitted_at,
    isActive: r.is_active,
    flags: r.flags,
    violations: r.violations,
  }));
}

const STATUS_LABEL = { not_started: 'Not started', in_progress: 'In progress', submitted: 'Submitted' } as const;

/** Stops spreadsheet apps from evaluating cell text as a formula. */
function safeCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function exportRows(rows: ResultRow[]) {
  return rows.map((r) => ({
    srCode: r.srCode,
    name: r.name,
    section: r.section,
    subject: r.subject,
    quiz: r.quiz,
    status: STATUS_LABEL[r.status],
    score: r.score,
    totalPoints: r.totalPoints,
    submittedAt: formatManila(r.submittedAt),
    violations: r.attemptId ? r.violations : null,
    flags: r.attemptId ? r.flags : null,
  }));
}

const HEADERS: [keyof ReturnType<typeof exportRows>[number], string][] = [
  ['srCode', 'SR Code'],
  ['name', 'Name'],
  ['section', 'Section'],
  ['subject', 'Subject'],
  ['quiz', 'Quiz'],
  ['status', 'Status'],
  ['score', 'Score'],
  ['totalPoints', 'Total Points'],
  ['submittedAt', 'Submitted (Asia/Manila)'],
  ['violations', 'Times Left Exam'],
  ['flags', 'Security Flags'],
];

export function resultsCsv(rows: ResultRow[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : safeCell(String(v));
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [HEADERS.map(([, h]) => h).join(',')];
  for (const r of exportRows(rows)) lines.push(HEADERS.map(([k]) => esc(r[k])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export async function resultsXlsx(rows: ResultRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet('Results');
  ws.columns = HEADERS.map(([key, header]) => ({ key, header, width: key === 'name' || key === 'quiz' ? 32 : key === 'submittedAt' ? 26 : 14 }));
  for (const r of exportRows(rows)) {
    ws.addRow({ ...r, srCode: safeCell(r.srCode), name: safeCell(r.name), quiz: safeCell(r.quiz) });
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// One attempt, with answer key (teacher only)
// ---------------------------------------------------------------------------

export async function attemptDetail(attemptId: number) {
  await autoSubmitExpired({ attemptId });
  const [row] = await prisma.$queryRaw<
    {
      id: number;
      status: string;
      score: number | null;
      started_at: Date;
      submitted_at: Date | null;
      current_index: number;
      question_order: number[];
      choice_order: Record<string, number[]>;
      deadline: Date;
      sr_code: string;
      name: string;
      section: string;
      quiz_id: number;
      title: string;
      total_points: number;
      secure_mode: boolean;
      max_violations: number;
      reopened_at: Date | null;
      extended_until: Date | null;
    }[]
  >`
    SELECT at.id, at.status, at.score, at.started_at, at.submitted_at, at.current_index, at.question_order, at.choice_order,
           at.reopened_at, at.extended_until,
           ${DEADLINE_SQL} AS deadline,
           u.sr_code, u.name, sec.name AS section, q.id AS quiz_id, q.title, ${TOTAL_POINTS_SQL} AS total_points,
           q.secure_mode, q.max_violations
    FROM attempts at
    JOIN assignments asg ON asg.id = at.assignment_id
    JOIN quizzes q ON q.id = asg.quiz_id
    JOIN users u ON u.id = at.student_id
    JOIN sections sec ON sec.id = asg.section_id
    WHERE at.id = ${attemptId}`;
  if (!row) throw notFound('Attempt not found');

  const ids = row.question_order.map(Number);
  const questions = await prisma.question.findMany({
    where: { id: { in: ids } },
    include: { choices: true, acceptedAnswers: true },
  });
  const byId = new Map(questions.map((q) => [q.id, q]));
  const answers = new Map((await prisma.attemptAnswer.findMany({ where: { attemptId } })).map((a) => [a.questionId, a]));
  const events = await prisma.attemptEvent.findMany({ where: { attemptId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const violations = events.filter((e) => (COUNTED_EVENT_TYPES as string[]).includes(e.type)).length;

  return {
    id: row.id,
    status: row.status,
    score: row.score,
    totalPoints: row.total_points,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
    deadline: row.deadline,
    currentIndex: row.current_index,
    reopenedAt: row.reopened_at,
    extendedUntil: row.extended_until,
    student: { srCode: row.sr_code, name: row.name, section: row.section },
    quiz: { id: row.quiz_id, title: row.title },
    security: {
      enabled: row.secure_mode,
      maxViolations: row.max_violations,
      violations,
      autoSubmitted: row.status === 'submitted' && row.secure_mode && row.max_violations > 0 && violations >= row.max_violations,
    },
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      counted: (COUNTED_EVENT_TYPES as string[]).includes(e.type),
      occurredAt: e.occurredAt,
      durationMs: e.durationMs,
      detail: e.detail,
    })),
    items: ids
      .map((id) => byId.get(id))
      .filter((q): q is NonNullable<typeof q> => !!q)
      .map((q, i) => {
        const a = answers.get(q.id);
        const given = a && a.answer !== '' ? a.answer : undefined; // '' = left blank (row exists only for a re-check)
        const choiceText = (cid: string | undefined) => q.choices.find((c) => String(c.id) === cid)?.text ?? null;
        return {
          number: i + 1,
          questionId: q.id,
          type: q.type,
          text: q.text,
          points: q.points,
          answer: q.type === 'multiple_choice' ? choiceText(given) : (given ?? null),
          correctAnswer:
            q.type === 'multiple_choice'
              ? (q.choices.find((c) => c.isCorrect)?.text ?? null)
              : q.acceptedAnswers.map((x) => x.answerText).join(' / '),
          isCorrect: a?.isCorrect ?? (row.status === 'submitted' ? false : null),
          pointsAwarded: a?.pointsAwarded ?? (row.status === 'submitted' ? 0 : null),
          /** What the automatic check decided (null before grading). */
          autoCorrect: a ? (a.autoCorrect ?? null) : row.status === 'submitted' ? false : null,
          /** True when the teacher re-checked this item. */
          overridden: a?.overrideCorrect !== null && a?.overrideCorrect !== undefined,
          overriddenAt: a?.overriddenAt ?? null,
          savedAt: given !== undefined ? a!.updatedAt : null,
        };
      }),
  };
}

/**
 * Teacher re-check ("consideration") of one item on a submitted attempt, for any question type, answered or blank.
 * correct = true gives the question's full points, false gives 0, null removes the re-check (back to the auto-check).
 * The decision is kept on every later re-grade.
 */
export async function recheckItem(attemptId: number, questionId: number, correct: boolean | null) {
  await prisma.$transaction(async (tx) => {
    const [a] = await tx.$queryRaw<{ status: string; question_order: number[] }[]>`
      SELECT status, question_order FROM attempts WHERE id = ${attemptId} FOR UPDATE`;
    if (!a) throw notFound('Attempt not found');
    if (a.status !== 'submitted') throw conflict('You can re-check an attempt only after it is submitted.', 'NOT_SUBMITTED');
    if (!a.question_order.map(Number).includes(questionId)) throw badRequest('That question is not part of this attempt');

    if (correct === null) {
      // Placeholder rows for items left blank are only there to hold a re-check.
      await tx.attemptAnswer.deleteMany({ where: { attemptId, questionId, answer: '' } });
      await tx.attemptAnswer.updateMany({ where: { attemptId, questionId }, data: { overrideCorrect: null, overriddenAt: null } });
    } else {
      await tx.$executeRaw`
        INSERT INTO attempt_answers (attempt_id, question_id, answer, override_correct, overridden_at, updated_at)
        VALUES (${attemptId}, ${questionId}, '', ${correct}, now(), now())
        ON CONFLICT (attempt_id, question_id)
        DO UPDATE SET override_correct = EXCLUDED.override_correct, overridden_at = now()`;
    }
    await gradeAttempt(tx, attemptId, { regrade: true });
  });
  return attemptDetail(attemptId);
}

/**
 * Reopens a submitted attempt so the student can revise their answers: same questions, same order, answers kept,
 * a new end time of now + minutes, and the leave-the-exam counter starts again. The score is recomputed when they submit.
 */
export async function reopenAttempt(attemptId: number, minutes: number) {
  await prisma.$transaction(async (tx) => {
    const [a] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM attempts WHERE id = ${attemptId} FOR UPDATE`;
    if (!a) throw notFound('Attempt not found');
    if (a.status !== 'submitted') throw conflict('This attempt is still in progress.', 'NOT_SUBMITTED');
    await tx.$executeRaw`
      UPDATE attempts SET status = 'in_progress', submitted_at = NULL, score = NULL,
             extended_until = now() + make_interval(mins => ${minutes}::int), reopened_at = now()
      WHERE id = ${attemptId}`;
    await tx.$executeRaw`
      INSERT INTO attempt_events (attempt_id, type, occurred_at, detail)
      VALUES (${attemptId}, 'reopened', now(), ${`reopened by the teacher for ${minutes} min`})`;
  });
  return attemptDetail(attemptId);
}

/** Deletes an attempt so the student can take the quiz again (only possible while the window is open). */
export async function resetAttempt(attemptId: number) {
  const a = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!a) throw notFound('Attempt not found');
  await prisma.attempt.delete({ where: { id: attemptId } });
}
