import { prisma } from '../db';
import { badRequest, conflict, notFound } from '../lib/http-error';
import type { AssignmentItemDto, UpdateAssignmentDto } from './teacher.dto';

export type ScheduleState = 'scheduled' | 'open' | 'closed';

function parseInstant(value: string, field: string): Date {
  // Require an explicit offset so "08:00" is never silently read in the server's time zone.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(value)) throw badRequest(`${field} must include a time zone offset, e.g. +08:00`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} is not a valid date`);
  return d;
}

/** Every section with this quiz's schedule (if any), state, and submission counts. */
export async function listForQuiz(quizId: number) {
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId }, include: { subject: true } });
  if (!quiz) throw notFound('Quiz not found');

  const rows = await prisma.$queryRaw<
    {
      section_id: number;
      section: string;
      assignment_id: number | null;
      start_at: Date | null;
      due_at: Date | null;
      state: ScheduleState | null;
      students: number;
      submitted: number;
      in_progress: number;
      now: Date;
    }[]
  >`
    SELECT sec.id AS section_id, sec.name AS section,
           asg.id AS assignment_id, asg.start_at, asg.due_at,
           CASE WHEN asg.id IS NULL THEN NULL
                WHEN now() < asg.start_at THEN 'scheduled'
                WHEN now() < asg.due_at THEN 'open'
                ELSE 'closed' END AS state,
           (SELECT count(*)::int FROM users u JOIN student_subjects en ON en.student_id = u.id
             WHERE en.section_id = sec.id AND en.subject_id = ${quiz.subjectId} AND u.is_active) AS students,
           (SELECT count(*)::int FROM attempts at WHERE at.assignment_id = asg.id AND at.status = 'submitted') AS submitted,
           (SELECT count(*)::int FROM attempts at WHERE at.assignment_id = asg.id AND at.status = 'in_progress') AS in_progress,
           now() AS now
    FROM sections sec
    JOIN section_subjects ss ON ss.section_id = sec.id AND ss.subject_id = ${quiz.subjectId}
    LEFT JOIN assignments asg ON asg.section_id = sec.id AND asg.quiz_id = ${quizId}
    ORDER BY sec.name`;

  return {
    quiz: { id: quiz.id, title: quiz.title, subject: quiz.subject.name, timeLimitMinutes: quiz.timeLimitMinutes },
    serverNow: rows[0]?.now ?? new Date(),
    sections: rows.map((r) => ({
      sectionId: r.section_id,
      section: r.section,
      students: r.students,
      assignment: r.assignment_id
        ? { id: r.assignment_id, startAt: r.start_at, dueAt: r.due_at, state: r.state, submitted: r.submitted, inProgress: r.in_progress }
        : null,
    })),
  };
}

export async function upsertForQuiz(quizId: number, items: AssignmentItemDto[]) {
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId }, select: { subjectId: true, _count: { select: { questions: true } } } });
  if (!quiz) throw notFound('Quiz not found');
  if (quiz._count.questions === 0) throw conflict('Add questions before assigning this quiz.', 'EMPTY_QUIZ');

  const allowed = new Set(
    (await prisma.sectionSubject.findMany({ where: { subjectId: quiz.subjectId } })).map((s) => s.sectionId),
  );
  const seen = new Set<number>();
  const parsed = items.map((it) => {
    if (!allowed.has(it.sectionId)) throw badRequest(`Section ${it.sectionId} does not take this subject`);
    if (seen.has(it.sectionId)) throw badRequest('Each section can appear only once');
    seen.add(it.sectionId);
    const startAt = parseInstant(it.startAt, 'startAt');
    const dueAt = parseInstant(it.dueAt, 'dueAt');
    if (dueAt <= startAt) throw badRequest('Due time must be after start time');
    return { sectionId: it.sectionId, startAt, dueAt };
  });

  await prisma.$transaction(
    parsed.map((p) =>
      prisma.assignment.upsert({
        where: { quizId_sectionId: { quizId, sectionId: p.sectionId } },
        create: { quizId, sectionId: p.sectionId, startAt: p.startAt, dueAt: p.dueAt },
        update: { startAt: p.startAt, dueAt: p.dueAt },
      }),
    ),
  );
  return listForQuiz(quizId);
}

export async function updateAssignment(id: number, dto: UpdateAssignmentDto) {
  const current = await prisma.assignment.findUnique({ where: { id } });
  if (!current) throw notFound('Assignment not found');
  const startAt = dto.startAt ? parseInstant(dto.startAt, 'startAt') : current.startAt;
  const dueAt = dto.dueAt ? parseInstant(dto.dueAt, 'dueAt') : current.dueAt;
  if (dueAt <= startAt) throw badRequest('Due time must be after start time');
  await prisma.assignment.update({ where: { id }, data: { startAt, dueAt } });
  return listForQuiz(current.quizId);
}

export async function deleteAssignment(id: number) {
  const a = await prisma.assignment.findUnique({ where: { id }, include: { _count: { select: { attempts: true } } } });
  if (!a) throw notFound('Assignment not found');
  if (a._count.attempts > 0) {
    throw conflict('Students in this section have already started. Change the dates instead of removing it.', 'HAS_ATTEMPTS');
  }
  await prisma.assignment.delete({ where: { id } });
  return listForQuiz(a.quizId);
}
