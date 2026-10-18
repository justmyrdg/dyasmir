import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db';

/**
 * SQL expression for an attempt's deadline: the earlier of (started_at + time limit) and the assignment's due_at,
 * unless the teacher reopened the attempt with a new end time.
 */
export const DEADLINE_SQL = Prisma.sql`COALESCE(at.extended_until, LEAST(at.started_at + make_interval(mins => q.time_limit_minutes), asg.due_at))`;

/**
 * SQL expression for what a student's quiz is out of (needs `q` and a possibly NULL `at`). Once started: the points
 * of the questions the attempt was given, which is a random pick when the quiz gives each student fewer items than
 * it has. Before that: all the quiz's points, or items per student × the points per item when every item is worth
 * the same; NULL when the items are worth different amounts, since the total depends on the pick.
 */
export const TOTAL_POINTS_SQL = Prisma.sql`CASE
  WHEN at.id IS NOT NULL THEN (SELECT coalesce(sum(tq.points), 0)::int FROM questions tq
                               WHERE tq.id IN (SELECT jsonb_array_elements_text(at.question_order)::int))
  WHEN q.items_per_student IS NULL THEN q.total_points
  ELSE (SELECT CASE WHEN min(tq.points) = max(tq.points) THEN (q.items_per_student * min(tq.points))::int END
        FROM questions tq WHERE tq.quiz_id = q.id)
END`;

/** Identification answers: case-insensitive, surrounding spaces ignored, inner runs of spaces collapsed. */
export function normalizeText(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

interface GradableQuestion {
  id: number;
  type: string;
  points: number;
  choices: { id: number; isCorrect: boolean }[];
  acceptedAnswers: { answerText: string }[];
}

export function isAnswerCorrect(q: GradableQuestion, answer: string): boolean {
  if (q.type === 'multiple_choice') {
    const correct = q.choices.find((c) => c.isCorrect);
    return !!correct && String(correct.id) === answer.trim();
  }
  const given = normalizeText(answer);
  return given.length > 0 && q.acceptedAnswers.some((a) => normalizeText(a.answerText) === given);
}

interface GradeOptions {
  /** Re-score an already submitted attempt (after the teacher fixes an answer key). */
  regrade?: boolean;
  /** Only submit if the deadline has passed (used by the scheduled job, re-checked under the row lock). */
  onlyIfExpired?: boolean;
}

/**
 * Grades an attempt inside the caller's transaction: marks every saved answer, computes the score and
 * (unless regrading) sets status = 'submitted' and submitted_at = now(). Returns true if anything was written.
 */
export async function gradeAttempt(tx: Tx, attemptId: number, opts: GradeOptions = {}): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ status: string; question_order: number[]; expired: boolean }[]>`
    SELECT at.status, at.question_order, (${DEADLINE_SQL} <= now()) AS expired
    FROM attempts at
    JOIN assignments asg ON asg.id = at.assignment_id
    JOIN quizzes q ON q.id = asg.quiz_id
    WHERE at.id = ${attemptId}
    FOR UPDATE OF at`;
  if (!row) return false;
  if (opts.regrade ? row.status !== 'submitted' : row.status === 'submitted') return false;
  if (opts.onlyIfExpired && !row.expired) return false;

  const questionIds = row.question_order.map(Number);
  const questions = await tx.question.findMany({
    where: { id: { in: questionIds } },
    select: {
      id: true,
      type: true,
      points: true,
      choices: { select: { id: true, isCorrect: true } },
      acceptedAnswers: { select: { answerText: true } },
    },
  });
  const byId = new Map(questions.map((q) => [q.id, q]));
  const answers = await tx.attemptAnswer.findMany({
    where: { attemptId },
    select: { questionId: true, answer: true, overrideCorrect: true },
  });

  let score = 0;
  for (const a of answers) {
    const q = byId.get(a.questionId);
    const auto = q ? isAnswerCorrect(q, a.answer) : false;
    // A teacher's re-check always wins over the automatic check, including on later re-grades.
    const correct = a.overrideCorrect ?? auto;
    const points = correct && q ? q.points : 0;
    score += points;
    await tx.attemptAnswer.update({
      where: { attemptId_questionId: { attemptId, questionId: a.questionId } },
      data: { autoCorrect: auto, isCorrect: correct, pointsAwarded: points },
    });
  }

  if (opts.regrade) {
    await tx.attempt.update({ where: { id: attemptId }, data: { score } });
  } else {
    await tx.$executeRaw`
      UPDATE attempts SET status = 'submitted', submitted_at = now(), score = ${score} WHERE id = ${attemptId}`;
  }
  return true;
}

export async function submitAndGrade(attemptId: number, opts: GradeOptions = {}): Promise<boolean> {
  return prisma.$transaction((tx) => gradeAttempt(tx, attemptId, opts));
}

/**
 * Submits and grades every in-progress attempt whose deadline has passed (optionally limited to one
 * student or one attempt). Used by the minute job and lazily before reading attempt state.
 */
export async function autoSubmitExpired(filter: { studentId?: number; attemptId?: number } = {}): Promise<number> {
  const conditions = [Prisma.sql`at.status = 'in_progress'`, Prisma.sql`${DEADLINE_SQL} <= now()`];
  if (filter.studentId !== undefined) conditions.push(Prisma.sql`at.student_id = ${filter.studentId}`);
  if (filter.attemptId !== undefined) conditions.push(Prisma.sql`at.id = ${filter.attemptId}`);

  const due = await prisma.$queryRaw<{ id: number }[]>`
    SELECT at.id FROM attempts at
    JOIN assignments asg ON asg.id = at.assignment_id
    JOIN quizzes q ON q.id = asg.quiz_id
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY at.id`;

  let submitted = 0;
  for (const { id } of due) {
    try {
      if (await submitAndGrade(id, { onlyIfExpired: true })) submitted++;
    } catch (err) {
      console.error(`[auto-submit] failed to grade attempt ${id}`, err);
    }
  }
  return submitted;
}

/** Re-scores all submitted attempts of a quiz (after its answer key or points changed). */
export async function regradeQuiz(tx: Tx, quizId: number): Promise<number> {
  const attempts = await tx.$queryRaw<{ id: number }[]>`
    SELECT at.id FROM attempts at JOIN assignments asg ON asg.id = at.assignment_id
    WHERE asg.quiz_id = ${quizId} AND at.status = 'submitted' ORDER BY at.id`;
  for (const { id } of attempts) await gradeAttempt(tx, id, { regrade: true });
  return attempts.length;
}
