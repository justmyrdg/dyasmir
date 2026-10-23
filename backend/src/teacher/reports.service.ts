import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { autoSubmitExpired, DEADLINE_SQL, gradeAttempt, TOTAL_POINTS_SQL } from '../attempts/grading';
import { COUNTED_EVENT_TYPES } from '../attempts/security';
import { dbNow, prisma, type Db, type Tx } from '../db';
import { safeCell, toCsv } from '../lib/csv';
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
  /** Part of the student's name (any case) or SR code. */
  search?: string;
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
  /** Different devices/browsers used during the attempt; more than 1 means the student switched. */
  devices: number;
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
  const search = filter.search?.trim();
  if (search) where.push(Prisma.sql`(strpos(lower(u.name), lower(${search})) > 0 OR strpos(u.sr_code, ${search}) > 0)`);

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
      devices: number;
    }[]
  >`
    SELECT u.id AS student_id, u.sr_code, u.name, sec.name AS section, u.is_active,
           q.id AS quiz_id, q.title AS quiz, sub.name AS subject, ${TOTAL_POINTS_SQL} AS total_points,
           at.id AS attempt_id, at.status, at.score, at.started_at, at.submitted_at,
           (SELECT count(*)::int FROM attempt_events e WHERE e.attempt_id = at.id) AS flags,
           (SELECT count(*)::int FROM attempt_events e
             WHERE e.attempt_id = at.id AND e.type = ANY(${COUNTED_EVENT_TYPES}::text[])) AS violations,
           (SELECT count(*)::int FROM attempt_devices d WHERE d.attempt_id = at.id) AS devices
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
    devices: r.devices,
  }));
}

const STATUS_LABEL = { not_started: 'Not started', in_progress: 'In progress', submitted: 'Submitted' } as const;

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
  return toCsv([
    HEADERS.map(([, h]) => h),
    ...exportRows(rows).map((r) => HEADERS.map(([k]) => (r[k] === null || r[k] === undefined ? null : safeCell(String(r[k]))))),
  ]);
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
      assignment_id: number;
      quiz_id: number;
      title: string;
      total_points: number;
      secure_mode: boolean;
      max_violations: number;
      reopened_at: Date | null;
      extended_until: Date | null;
      now: Date;
    }[]
  >`
    SELECT at.id, at.status, at.score, at.started_at, at.submitted_at, at.current_index, at.question_order, at.choice_order,
           at.reopened_at, at.extended_until,
           ${DEADLINE_SQL} AS deadline, now() AS now,
           u.sr_code, u.name, sec.name AS section, at.assignment_id, q.id AS quiz_id, q.title, ${TOTAL_POINTS_SQL} AS total_points,
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
  const reopenRequest = await prisma.reopenRequest.findFirst({
    where: { attemptId, status: 'pending' },
    select: { id: true, message: true, createdAt: true },
  });

  const devices = await prisma.attemptDevice.findMany({ where: { attemptId }, orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }] });
  // Another student's attempt at the same quiz from the same browser (same random id): possibly sharing a device.
  const shared = devices.length
    ? await prisma.$queryRaw<{ device_key: string; attempt_id: number; name: string; sr_code: string }[]>`
        SELECT DISTINCT d.device_key, at.id AS attempt_id, u.name, u.sr_code
        FROM attempt_devices d
        JOIN attempts at ON at.id = d.attempt_id
        JOIN users u ON u.id = at.student_id
        WHERE at.assignment_id = ${row.assignment_id} AND at.id <> ${attemptId}
          AND d.device_key LIKE 'b:%' AND d.device_key = ANY(${devices.map((d) => d.deviceKey)}::text[])
        ORDER BY u.name`
    : [];

  return {
    id: row.id,
    status: row.status,
    score: row.score,
    totalPoints: row.total_points,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
    deadline: row.deadline,
    serverNow: row.now,
    currentIndex: row.current_index,
    reopenedAt: row.reopened_at,
    extendedUntil: row.extended_until,
    /** The student's pending request to reopen it (after being submitted for leaving the exam), if any. */
    reopenRequest,
    student: { srCode: row.sr_code, name: row.name, section: row.section },
    quiz: { id: row.quiz_id, title: row.title },
    security: {
      enabled: row.secure_mode,
      maxViolations: row.max_violations,
      violations,
      autoSubmitted: row.status === 'submitted' && row.secure_mode && row.max_violations > 0 && violations >= row.max_violations,
    },
    /** Each device/browser seen during the attempt, first one first. */
    devices: devices.map((d) => ({
      id: d.id,
      deviceType: d.deviceType,
      os: d.os,
      browser: d.browser,
      model: d.model,
      screen: d.screen,
      touch: d.touch,
      ip: d.ip,
      userAgent: d.userAgent,
      firstSeenAt: d.firstSeenAt,
      lastSeenAt: d.lastSeenAt,
      alsoUsedBy: shared
        .filter((x) => x.device_key === d.deviceKey)
        .map((x) => ({ attemptId: x.attempt_id, name: x.name, srCode: x.sr_code })),
    })),
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
 * and the leave-the-exam counter starts again. The score is recomputed when they submit.
 * minutes = a new end time of now + minutes; null = keep the end time it has (the clock kept running meanwhile).
 * A pending reopen request from the student is answered as approved.
 */
async function reopenInTx(tx: Tx, attemptId: number, minutes: number | null, detail: string) {
  const [a] = await tx.$queryRaw<{ status: string; time_left: boolean }[]>`
    SELECT at.status, ${DEADLINE_SQL} > now() AS time_left
    FROM attempts at
    JOIN assignments asg ON asg.id = at.assignment_id
    JOIN quizzes q ON q.id = asg.quiz_id
    WHERE at.id = ${attemptId}
    FOR UPDATE OF at`;
  if (!a) throw notFound('Attempt not found');
  if (a.status !== 'submitted') throw conflict('This attempt is still in progress.', 'NOT_SUBMITTED');
  if (minutes === null && !a.time_left) {
    throw conflict("This attempt's end time has passed, so there is no time left to reopen it with. Give extra minutes instead.", 'TIME_UP');
  }
  const newEnd = minutes === null ? Prisma.empty : Prisma.sql`, extended_until = now() + make_interval(mins => ${minutes}::int)`;
  await tx.$executeRaw`
    UPDATE attempts SET status = 'in_progress', submitted_at = NULL, score = NULL, reopened_at = now() ${newEnd}
    WHERE id = ${attemptId}`;
  await tx.$executeRaw`
    INSERT INTO attempt_events (attempt_id, type, occurred_at, detail)
    VALUES (${attemptId}, 'reopened', now(), ${minutes === null ? detail : `${detail} for ${minutes} min`})`;
  await tx.$executeRaw`
    UPDATE reopen_requests SET status = 'approved', resolved_at = now() WHERE attempt_id = ${attemptId} AND status = 'pending'`;
}

export async function reopenAttempt(attemptId: number, minutes: number | null) {
  await prisma.$transaction((tx) =>
    reopenInTx(tx, attemptId, minutes, minutes === null ? 'reopened by the teacher, end time unchanged' : 'reopened by the teacher'),
  );
  return attemptDetail(attemptId);
}

// ---------------------------------------------------------------------------
// Reopen requests from students submitted for leaving the exam
// ---------------------------------------------------------------------------

export async function listReopenRequests() {
  const rows = await prisma.$queryRaw<
    {
      id: number;
      attempt_id: number;
      message: string | null;
      created_at: Date;
      deadline: Date;
      name: string;
      sr_code: string;
      section: string;
      quiz_id: number;
      title: string;
    }[]
  >`
    SELECT r.id, r.attempt_id, r.message, r.created_at, ${DEADLINE_SQL} AS deadline,
           u.name, u.sr_code, sec.name AS section, q.id AS quiz_id, q.title
    FROM reopen_requests r
    JOIN attempts at ON at.id = r.attempt_id
    JOIN assignments asg ON asg.id = at.assignment_id
    JOIN quizzes q ON q.id = asg.quiz_id
    JOIN users u ON u.id = at.student_id
    JOIN sections sec ON sec.id = asg.section_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at, r.id`;
  return {
    serverNow: await dbNow(),
    items: rows.map((r) => ({
      id: r.id,
      attemptId: r.attempt_id,
      message: r.message,
      createdAt: r.created_at,
      /** Unchanged by approving: the student comes back to whatever time is left. */
      deadline: r.deadline,
      student: { name: r.name, srCode: r.sr_code, section: r.section },
      quiz: { id: r.quiz_id, title: r.title },
    })),
  };
}

async function pendingRequest(db: Db, requestId: number) {
  const r = await db.reopenRequest.findUnique({ where: { id: requestId } });
  if (!r) throw notFound('Request not found');
  if (r.status !== 'pending') throw conflict('This request has already been answered.', 'NOT_PENDING');
  return r;
}

export async function approveReopenRequest(requestId: number) {
  await prisma.$transaction(async (tx) => {
    const r = await pendingRequest(tx, requestId);
    await reopenInTx(tx, r.attemptId, null, "reopened at the student's request, end time unchanged");
  });
  return { id: requestId, status: 'approved' as const };
}

export async function declineReopenRequest(requestId: number) {
  await pendingRequest(prisma, requestId);
  await prisma.$executeRaw`UPDATE reopen_requests SET status = 'declined', resolved_at = now() WHERE id = ${requestId} AND status = 'pending'`;
  return { id: requestId, status: 'declined' as const };
}

/** Deletes an attempt so the student can take the quiz again (only possible while the window is open). */
export async function resetAttempt(attemptId: number) {
  const a = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!a) throw notFound('Attempt not found');
  await prisma.attempt.delete({ where: { id: attemptId } });
}
