import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { prisma, type Db } from '../db';
import { badRequest, conflict, notFound } from '../lib/http-error';
import { shuffled } from '../lib/shuffle';
import type { RecordEventsDto, SaveAttemptDto } from './attempts.dto';
import { autoSubmitExpired, DEADLINE_SQL, gradeAttempt, TOTAL_POINTS_SQL } from './grading';
import { COUNTED_EVENT_TYPES, MAX_EVENTS_PER_ATTEMPT } from './security';

export type StudentQuizStatus = 'not_yet_open' | 'open' | 'in_progress' | 'closed' | 'submitted';

interface AttemptRow {
  id: number;
  assignment_id: number;
  student_id: number;
  started_at: Date;
  question_order: number[];
  choice_order: Record<string, number[]>;
  current_index: number;
  status: 'in_progress' | 'submitted';
  submitted_at: Date | null;
  score: number | null;
  deadline: Date;
  now: Date;
  quiz_id: number;
  title: string;
  subject: string;
  time_limit_minutes: number;
  total_points: number;
  show_results_to_students: boolean;
  secure_mode: boolean;
  max_violations: number;
}

async function loadAttempt(db: Db, attemptId: number, forUpdate = false): Promise<AttemptRow | undefined> {
  const [row] = await db.$queryRaw<AttemptRow[]>`
    SELECT at.id, at.assignment_id, at.student_id, at.started_at, at.question_order, at.choice_order,
           at.current_index, at.status, at.submitted_at, at.score,
           ${DEADLINE_SQL} AS deadline, now() AS now,
           q.id AS quiz_id, q.title, s.name AS subject, q.time_limit_minutes, ${TOTAL_POINTS_SQL} AS total_points,
           q.show_results_to_students, q.secure_mode, q.max_violations
    FROM attempts at
    JOIN assignments asg ON asg.id = at.assignment_id
    JOIN quizzes q ON q.id = asg.quiz_id
    JOIN subjects s ON s.id = q.subject_id
    WHERE at.id = ${attemptId}
    ${forUpdate ? Prisma.sql`FOR UPDATE OF at` : Prisma.empty}`;
  return row;
}

/** Students may only ever see their own attempts; anything else looks like "not found". */
async function loadOwnAttempt(db: Db, user: AuthUser, attemptId: number, forUpdate = false): Promise<AttemptRow> {
  const row = await loadAttempt(db, attemptId, forUpdate);
  if (!row || row.student_id !== user.id) throw notFound('Attempt not found');
  return row;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function listAssignmentsForStudent(user: AuthUser) {
  await autoSubmitExpired({ studentId: user.id });

  const rows = await prisma.$queryRaw<
    {
      assignment_id: number;
      start_at: Date;
      due_at: Date;
      quiz_id: number;
      title: string;
      subject: string;
      time_limit_minutes: number;
      total_points: number | null;
      question_count: number;
      secure_mode: boolean;
      max_violations: number;
      attempt_id: number | null;
      attempt_status: 'in_progress' | 'submitted' | null;
      score: number | null;
      submitted_at: Date | null;
      deadline: Date | null;
      now: Date;
    }[]
  >`
    SELECT asg.id AS assignment_id, asg.start_at, asg.due_at,
           q.id AS quiz_id, q.title, s.name AS subject, q.time_limit_minutes, ${TOTAL_POINTS_SQL} AS total_points,
           CASE WHEN at.id IS NOT NULL THEN jsonb_array_length(at.question_order)
                ELSE coalesce(q.items_per_student, (SELECT count(*)::int FROM questions qq WHERE qq.quiz_id = q.id)) END AS question_count,
           q.secure_mode, q.max_violations,
           at.id AS attempt_id, at.status AS attempt_status, at.score, at.submitted_at,
           CASE WHEN at.id IS NULL THEN NULL ELSE ${DEADLINE_SQL} END AS deadline,
           now() AS now
    FROM assignments asg
    JOIN quizzes q ON q.id = asg.quiz_id
    JOIN subjects s ON s.id = q.subject_id
    LEFT JOIN attempts at ON at.assignment_id = asg.id AND at.student_id = ${user.id}
    -- Quizzes assigned to the section the student takes that subject in
    -- (an attempt already taken stays visible even if the enrollment changed later).
    WHERE EXISTS (SELECT 1 FROM student_subjects en
                  WHERE en.student_id = ${user.id} AND en.subject_id = q.subject_id AND en.section_id = asg.section_id)
       OR at.id IS NOT NULL
    ORDER BY asg.due_at, q.title`;

  const serverNow = rows[0]?.now ?? (await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now;

  const items = rows.map((r) => {
    let status: StudentQuizStatus;
    if (r.attempt_status === 'submitted') status = 'submitted';
    else if (r.attempt_status === 'in_progress') status = 'in_progress';
    else if (r.now < r.start_at) status = 'not_yet_open';
    else if (r.now < r.due_at) status = 'open';
    else status = 'closed';
    return {
      assignmentId: r.assignment_id,
      quizId: r.quiz_id,
      title: r.title,
      subject: r.subject,
      timeLimitMinutes: r.time_limit_minutes,
      totalPoints: r.total_points,
      questionCount: r.question_count,
      secureMode: r.secure_mode,
      maxViolations: r.max_violations,
      startAt: r.start_at,
      dueAt: r.due_at,
      status,
      attemptId: r.attempt_id,
      deadline: status === 'in_progress' ? r.deadline : null,
      score: r.attempt_status === 'submitted' ? r.score : null,
      submittedAt: r.submitted_at,
    };
  });
  return { serverNow, items };
}

// ---------------------------------------------------------------------------
// Start / resume
// ---------------------------------------------------------------------------

/**
 * Returns the student's attempt for this assignment, creating it on first start.
 * The questions (a random pick per student when the quiz sets items per student) and their order are chosen
 * exactly once, here, and never again.
 */
export async function startAttempt(user: AuthUser, assignmentId: number): Promise<{ attemptId: number; created: boolean }> {
  return prisma.$transaction(async (tx) => {
    const [asg] = await tx.$queryRaw<
      {
        id: number;
        section_id: number;
        quiz_id: number;
        shuffle_questions: boolean;
        shuffle_choices: boolean;
        items_per_student: number | null;
        not_yet_open: boolean;
        is_open: boolean;
        enrolled: boolean;
      }[]
    >`
      SELECT asg.id, asg.section_id, asg.quiz_id, q.shuffle_questions, q.shuffle_choices, q.items_per_student,
             now() < asg.start_at AS not_yet_open,
             (asg.start_at <= now() AND now() < asg.due_at) AS is_open,
             EXISTS (SELECT 1 FROM student_subjects en
                     WHERE en.student_id = ${user.id} AND en.subject_id = q.subject_id AND en.section_id = asg.section_id) AS enrolled
      FROM assignments asg JOIN quizzes q ON q.id = asg.quiz_id
      WHERE asg.id = ${assignmentId}`;
    if (!asg) throw notFound('Quiz not found');

    const existing = await tx.attempt.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId: user.id } },
      select: { id: true },
    });
    if (existing) return { attemptId: existing.id, created: false };

    // Not enrolled in this subject with this assignment's section: same as not assigned.
    if (!asg.enrolled) throw notFound('Quiz not found');

    if (!asg.is_open) {
      throw asg.not_yet_open ? conflict('This quiz is not open yet.', 'NOT_OPEN') : conflict('This quiz is closed.', 'CLOSED');
    }

    const questions = await tx.question.findMany({
      where: { quizId: asg.quiz_id },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, type: true, choices: { select: { id: true }, orderBy: [{ position: 'asc' }, { id: 'asc' }] } },
    });
    if (questions.length === 0) throw conflict('This quiz has no questions yet.', 'EMPTY_QUIZ');

    // A fresh random pick for every student; without question shuffling the picked ones keep the quiz order.
    const n = asg.items_per_student;
    const picked = n !== null && n < questions.length ? new Set(shuffled(questions.map((q) => q.id)).slice(0, n)) : null;
    const given = picked ? questions.filter((q) => picked.has(q.id)) : questions;

    const ids = given.map((q) => q.id);
    const questionOrder = asg.shuffle_questions ? shuffled(ids) : ids;
    const choiceOrder: Record<string, number[]> = {};
    for (const q of given) {
      if (q.type !== 'multiple_choice') continue;
      const cids = q.choices.map((c) => c.id);
      choiceOrder[String(q.id)] = asg.shuffle_choices ? shuffled(cids) : cids;
    }

    // started_at comes from the database clock. ON CONFLICT covers a double-click / two devices racing.
    const inserted = await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO attempts (assignment_id, student_id, started_at, question_order, choice_order, current_index, status)
      VALUES (${assignmentId}, ${user.id}, now(), ${JSON.stringify(questionOrder)}::jsonb, ${JSON.stringify(choiceOrder)}::jsonb, 0, 'in_progress')
      ON CONFLICT (assignment_id, student_id) DO NOTHING
      RETURNING id`;
    if (inserted.length) return { attemptId: inserted[0].id, created: true };

    const winner = await tx.attempt.findUniqueOrThrow({
      where: { assignmentId_studentId: { assignmentId, studentId: user.id } },
      select: { id: true },
    });
    return { attemptId: winner.id, created: false };
  });
}

/** Everything the quiz screen needs to resume exactly where the student left off. Never includes answer keys. */
export async function getAttemptForStudent(user: AuthUser, attemptId: number) {
  await loadOwnAttempt(prisma, user, attemptId); // ownership check before any side effects
  await autoSubmitExpired({ attemptId });
  const row = await loadOwnAttempt(prisma, user, attemptId);

  const base = {
    id: row.id,
    assignmentId: row.assignment_id,
    status: row.status,
    quiz: { id: row.quiz_id, title: row.title, subject: row.subject, timeLimitMinutes: row.time_limit_minutes, totalPoints: row.total_points },
    startedAt: row.started_at,
    deadline: row.deadline,
    serverNow: row.now,
    security: {
      enabled: row.secure_mode,
      maxViolations: row.max_violations,
      violations: await countViolations(prisma, attemptId),
    },
  };
  if (row.status === 'submitted') return { ...base, questions: [], answers: {}, currentIndex: 0 };

  const questionIds = row.question_order.map(Number);
  const questions = await prisma.question.findMany({
    where: { id: { in: questionIds } },
    // Deliberately no is_correct and no accepted_answers.
    select: { id: true, type: true, text: true, points: true, choices: { select: { id: true, text: true } } },
  });
  const byId = new Map(questions.map((q) => [q.id, q]));

  const ordered = questionIds
    .map((id) => byId.get(id))
    .filter((q): q is NonNullable<typeof q> => !!q)
    .map((q) => {
      const choiceText = new Map(q.choices.map((c) => [c.id, c.text]));
      const order = row.choice_order[String(q.id)] ?? q.choices.map((c) => c.id);
      return {
        id: q.id,
        type: q.type as 'multiple_choice' | 'identification',
        text: q.text,
        points: q.points,
        choices:
          q.type === 'multiple_choice'
            ? order.filter((cid) => choiceText.has(cid)).map((cid) => ({ id: cid, text: choiceText.get(cid)! }))
            : [],
      };
    });

  const saved = await prisma.attemptAnswer.findMany({ where: { attemptId }, select: { questionId: true, answer: true } });
  const answers: Record<string, string> = {};
  for (const a of saved) answers[String(a.questionId)] = a.answer;

  return {
    ...base,
    questions: ordered,
    answers,
    currentIndex: Math.min(row.current_index, Math.max(ordered.length - 1, 0)),
  };
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

export async function saveProgress(user: AuthUser, attemptId: number, dto: SaveAttemptDto) {
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await loadOwnAttempt(tx, user, attemptId, true);
    if (row.status === 'submitted') return { kind: 'submitted' as const };
    if (row.now >= row.deadline) {
      await gradeAttempt(tx, attemptId);
      return { kind: 'time_up' as const };
    }

    const questionIds = new Set(row.question_order.map(Number));
    const types = new Map(
      (await tx.question.findMany({ where: { id: { in: [...questionIds] } }, select: { id: true, type: true } })).map((q) => [q.id, q.type]),
    );

    // Last write per question wins within one request.
    const latest = new Map<number, string>();
    for (const a of dto.answers ?? []) latest.set(a.questionId, a.answer);

    for (const [questionId, rawAnswer] of latest) {
      if (!questionIds.has(questionId) || !types.has(questionId)) throw badRequest(`Question ${questionId} is not part of this attempt`);
      let answer = rawAnswer;
      if (types.get(questionId) === 'multiple_choice' && answer !== '') {
        const allowed = row.choice_order[String(questionId)] ?? [];
        if (!allowed.map(String).includes(answer.trim())) throw badRequest(`Invalid choice for question ${questionId}`);
        answer = answer.trim();
      }
      if (answer.trim() === '') {
        await tx.attemptAnswer.deleteMany({ where: { attemptId, questionId } });
      } else {
        await tx.$executeRaw`
          INSERT INTO attempt_answers (attempt_id, question_id, answer, updated_at)
          VALUES (${attemptId}, ${questionId}, ${answer}, now())
          ON CONFLICT (attempt_id, question_id)
          DO UPDATE SET answer = EXCLUDED.answer, updated_at = now(), is_correct = NULL, points_awarded = NULL, auto_correct = NULL,
            -- a teacher re-check was about the old answer; drop it if the student changed the answer (after a reopen)
            override_correct = CASE WHEN attempt_answers.answer IS DISTINCT FROM EXCLUDED.answer THEN NULL ELSE attempt_answers.override_correct END,
            overridden_at = CASE WHEN attempt_answers.answer IS DISTINCT FROM EXCLUDED.answer THEN NULL ELSE attempt_answers.overridden_at END`;
      }
    }

    if (dto.currentIndex !== undefined) {
      if (dto.currentIndex >= row.question_order.length) throw badRequest('currentIndex is out of range');
      await tx.attempt.update({ where: { id: attemptId }, data: { currentIndex: dto.currentIndex } });
    }

    return { kind: 'saved' as const, deadline: row.deadline, serverNow: row.now };
  });

  if (outcome.kind === 'submitted') throw conflict('This attempt has already been submitted.', 'ATTEMPT_SUBMITTED');
  if (outcome.kind === 'time_up') throw conflict('Time is up. Your saved answers were submitted.', 'TIME_UP');
  return { saved: true, deadline: outcome.deadline, serverNow: outcome.serverNow };
}

// ---------------------------------------------------------------------------
// Submit and result
// ---------------------------------------------------------------------------

export async function submitAttempt(user: AuthUser, attemptId: number) {
  await prisma.$transaction(async (tx) => {
    await loadOwnAttempt(tx, user, attemptId, true);
    await gradeAttempt(tx, attemptId); // no-op if already submitted
  });
  return getResultForStudent(user, attemptId);
}

// ---------------------------------------------------------------------------
// Exam security events
// ---------------------------------------------------------------------------

async function securitySummary(row: AttemptRow, attemptId: number) {
  const violations = await countViolations(prisma, attemptId);
  return {
    enabled: row.secure_mode,
    violations,
    maxViolations: row.max_violations,
    /** Submitted by the system because the student left the exam too many times. */
    autoSubmitted: row.secure_mode && row.max_violations > 0 && violations >= row.max_violations,
  };
}

/** Times the student left the exam since it was last reopened (this is what the auto-submit limit counts). */
export async function countViolations(db: Db, attemptId: number): Promise<number> {
  const [r] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM attempt_events e
    WHERE e.attempt_id = ${attemptId} AND e.type = ANY(${COUNTED_EVENT_TYPES}::text[])
      AND e.occurred_at > coalesce((SELECT reopened_at FROM attempts WHERE id = ${attemptId}), '-infinity'::timestamptz)`;
  return r.n;
}

/**
 * Opening the exam page again (reload, closed tab, another device, back from another page of the app) means the
 * student was away in a way the page cannot report while it unloads. Every open after the first one since the
 * attempt started or was last reopened is therefore recorded as leaving the exam.
 */
async function recordReopen(db: Db, attemptId: number, openedEventId: number) {
  await db.$executeRaw`
    INSERT INTO attempt_events (attempt_id, type, occurred_at, detail)
    SELECT ${attemptId}, 'left_page', now(), 'closed, reloaded or left the exam page, then opened it again'
    WHERE EXISTS (
      SELECT 1 FROM attempt_events e
      WHERE e.attempt_id = ${attemptId} AND e.type = 'page_opened' AND e.id <> ${openedEventId}
        AND e.occurred_at > coalesce((SELECT reopened_at FROM attempts WHERE id = ${attemptId}), '-infinity'::timestamptz))`;
}

/**
 * Stores security events from the quiz screen (server time), and submits the attempt automatically
 * once the student has left the exam as many times as the quiz allows.
 */
export async function recordEvents(user: AuthUser, attemptId: number, dto: RecordEventsDto) {
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await loadOwnAttempt(tx, user, attemptId, true);
    if (row.status === 'submitted') return { status: 'submitted' as const, autoSubmitted: false };
    if (row.now >= row.deadline) {
      await gradeAttempt(tx, attemptId);
      return { status: 'submitted' as const, autoSubmitted: false };
    }
    if (!row.secure_mode) return { status: 'in_progress' as const, autoSubmitted: false };

    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM attempt_events WHERE attempt_id = ${attemptId}`;
    const room = Math.max(0, MAX_EVENTS_PER_ATTEMPT - n);
    for (const e of dto.events.slice(0, room)) {
      const clientTime = e.clientTime ? new Date(e.clientTime) : null;
      const inserted = await tx.$queryRaw<{ id: number }[]>`
        INSERT INTO attempt_events (attempt_id, type, occurred_at, client_time, duration_ms, detail, client_id)
        VALUES (${attemptId}, ${e.type}, now(), ${clientTime && !Number.isNaN(clientTime.getTime()) ? clientTime : null},
                ${e.durationMs ?? null}, ${e.detail?.slice(0, 200) ?? null}, ${e.id ?? null})
        ON CONFLICT (attempt_id, client_id) DO NOTHING
        RETURNING id`;
      // A resent event (same client id) inserts nothing, so a re-open is never counted twice.
      if (e.type === 'page_opened' && inserted.length) await recordReopen(tx, attemptId, inserted[0].id);
    }

    const violations = await countViolations(tx, attemptId);
    if (row.max_violations > 0 && violations >= row.max_violations) {
      await gradeAttempt(tx, attemptId);
      return { status: 'submitted' as const, autoSubmitted: true, violations, maxViolations: row.max_violations };
    }
    return { status: 'in_progress' as const, autoSubmitted: false, violations, maxViolations: row.max_violations };
  });
  return outcome;
}

export async function getResultForStudent(user: AuthUser, attemptId: number) {
  await loadOwnAttempt(prisma, user, attemptId);
  await autoSubmitExpired({ attemptId });
  const row = await loadOwnAttempt(prisma, user, attemptId);
  if (row.status !== 'submitted') throw conflict('This attempt has not been submitted yet.', 'NOT_SUBMITTED');

  const result = {
    id: row.id,
    quiz: { id: row.quiz_id, title: row.title, subject: row.subject, totalPoints: row.total_points },
    score: row.score ?? 0,
    totalPoints: row.total_points,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
    showDetails: row.show_results_to_students,
    security: await securitySummary(row, attemptId),
    items: [] as {
      number: number;
      type: string;
      text: string;
      points: number;
      yourAnswer: string | null;
      isCorrect: boolean;
      pointsAwarded: number;
    }[],
  };
  if (!row.show_results_to_students) return result;

  // Feedback says right/wrong per item, but never reveals the correct answer:
  // other sections may take the same quiz later.
  const questionIds = row.question_order.map(Number);
  const questions = await prisma.question.findMany({
    where: { id: { in: questionIds } },
    select: { id: true, type: true, text: true, points: true, choices: { select: { id: true, text: true } } },
  });
  const byId = new Map(questions.map((q) => [q.id, q]));
  const answers = new Map(
    (await prisma.attemptAnswer.findMany({ where: { attemptId } })).map((a) => [a.questionId, a]),
  );

  let n = 0;
  for (const qid of questionIds) {
    const q = byId.get(qid);
    if (!q) continue;
    const a = answers.get(qid);
    let yourAnswer: string | null = a?.answer ?? null;
    if (yourAnswer && q.type === 'multiple_choice') yourAnswer = q.choices.find((c) => String(c.id) === yourAnswer)?.text ?? null;
    result.items.push({
      number: ++n,
      type: q.type,
      text: q.text,
      points: q.points,
      yourAnswer,
      isCorrect: a?.isCorrect ?? false,
      pointsAwarded: a?.pointsAwarded ?? 0,
    });
  }
  return result;
}
