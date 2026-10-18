import { regradeQuiz } from '../attempts/grading';
import { prisma, type Tx } from '../db';
import { badRequest, conflict, notFound } from '../lib/http-error';
import { normalizeQuiz, quizList, type SubjectLookup } from './quiz-import';
import type { QuestionDto, QuizDto } from './teacher.dto';

const LONG_TX = { timeout: 60_000, maxWait: 10_000 };

export async function subjectLookup(): Promise<SubjectLookup> {
  const subjects = await prisma.subject.findMany();
  return {
    byName: new Map(subjects.map((s) => [s.name.toLowerCase(), s.id])),
    ids: new Set(subjects.map((s) => s.id)),
  };
}

export async function listQuizzes() {
  const quizzes = await prisma.quiz.findMany({
    orderBy: [{ subject: { name: 'asc' } }, { createdAt: 'asc' }],
    include: {
      subject: { select: { id: true, name: true } },
      _count: { select: { questions: true } },
      assignments: { select: { id: true, sectionId: true, startAt: true, dueAt: true, section: { select: { name: true } } } },
    },
  });
  return quizzes.map((q) => ({
    id: q.id,
    title: q.title,
    subject: q.subject,
    timeLimitMinutes: q.timeLimitMinutes,
    totalPoints: q.totalPoints,
    questionCount: q._count.questions,
    shuffleQuestions: q.shuffleQuestions,
    shuffleChoices: q.shuffleChoices,
    showResultsToStudents: q.showResultsToStudents,
    secureMode: q.secureMode,
    maxViolations: q.maxViolations,
    itemsPerStudent: q.itemsPerStudent,
    createdAt: q.createdAt,
    assignments: q.assignments.map((a) => ({ id: a.id, sectionId: a.sectionId, section: a.section.name, startAt: a.startAt, dueAt: a.dueAt })),
  }));
}

async function attemptCount(db: Tx | typeof prisma, quizId: number): Promise<number> {
  return db.attempt.count({ where: { assignment: { quizId } } });
}

/** Full quiz including answer keys. Teacher only. */
export async function getQuiz(id: number) {
  const quiz = await prisma.quiz.findUnique({
    where: { id },
    include: {
      subject: { select: { id: true, name: true } },
      questions: {
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        include: {
          choices: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
          acceptedAnswers: { orderBy: { id: 'asc' } },
        },
      },
    },
  });
  if (!quiz) throw notFound('Quiz not found');
  const attempts = await attemptCount(prisma, id);
  return {
    id: quiz.id,
    subjectId: quiz.subjectId,
    subject: quiz.subject,
    title: quiz.title,
    timeLimitMinutes: quiz.timeLimitMinutes,
    shuffleQuestions: quiz.shuffleQuestions,
    shuffleChoices: quiz.shuffleChoices,
    showResultsToStudents: quiz.showResultsToStudents,
    secureMode: quiz.secureMode,
    maxViolations: quiz.maxViolations,
    itemsPerStudent: quiz.itemsPerStudent,
    totalPoints: quiz.totalPoints,
    createdAt: quiz.createdAt,
    attemptCount: attempts,
    // Once anyone has started, questions/choices can't be added or removed (attempts store their ids).
    structureLocked: attempts > 0,
    questions: quiz.questions.map((q) => ({
      id: q.id,
      type: q.type,
      text: q.text,
      points: q.points,
      choices: q.type === 'multiple_choice' ? q.choices.map((c) => ({ id: c.id, text: c.text, isCorrect: c.isCorrect })) : undefined,
      acceptedAnswers: q.type === 'identification' ? q.acceptedAnswers.map((a) => a.answerText) : undefined,
    })),
  };
}

function checkQuestions(questions: QuestionDto[]) {
  questions.forEach((q, i) => {
    if (q.type === 'multiple_choice') {
      const n = (q.choices ?? []).filter((c) => c.isCorrect).length;
      if (n !== 1) throw badRequest(`Question ${i + 1}: exactly one choice must be marked correct`);
    } else {
      const answers = (q.acceptedAnswers ?? []).map((a) => a.trim()).filter(Boolean);
      if (answers.length === 0) throw badRequest(`Question ${i + 1}: add at least one accepted answer`);
    }
  });
}

function checkItemsPerStudent(itemsPerStudent: number | null | undefined, questionCount: number) {
  if (itemsPerStudent != null && itemsPerStudent > questionCount) {
    throw badRequest(`Items per student (${itemsPerStudent}) can't be more than the number of questions (${questionCount}).`);
  }
}

const totalPoints = (questions: QuestionDto[]) => questions.reduce((s, q) => s + q.points, 0);

function questionCreateData(q: QuestionDto, position: number) {
  return {
    type: q.type,
    text: q.text.trim(),
    points: q.points,
    position,
    choices:
      q.type === 'multiple_choice'
        ? { create: q.choices!.map((c, i) => ({ text: c.text.trim(), isCorrect: c.isCorrect, position: i })) }
        : undefined,
    acceptedAnswers:
      q.type === 'identification'
        ? { create: [...new Set(q.acceptedAnswers!.map((a) => a.trim()).filter(Boolean))].map((answerText) => ({ answerText })) }
        : undefined,
  };
}

async function assertSubject(tx: Tx, subjectId: number) {
  if (!(await tx.subject.findUnique({ where: { id: subjectId } }))) throw badRequest('Unknown subject');
}

export async function createQuiz(dto: QuizDto, tx?: Tx) {
  checkQuestions(dto.questions);
  checkItemsPerStudent(dto.itemsPerStudent, dto.questions.length);
  const run = async (t: Tx) => {
    await assertSubject(t, dto.subjectId);
    return t.quiz.create({
      data: {
        subjectId: dto.subjectId,
        title: dto.title.trim(),
        timeLimitMinutes: dto.timeLimitMinutes,
        shuffleQuestions: dto.shuffleQuestions,
        shuffleChoices: dto.shuffleChoices,
        showResultsToStudents: dto.showResultsToStudents,
        secureMode: dto.secureMode ?? true,
        maxViolations: dto.maxViolations ?? 5,
        itemsPerStudent: dto.itemsPerStudent ?? null,
        totalPoints: totalPoints(dto.questions),
        questions: { create: dto.questions.map((q, i) => questionCreateData(q, i)) },
      },
      select: { id: true },
    });
  };
  const created = tx ? await run(tx) : await prisma.$transaction(run, LONG_TX);
  return created;
}

/**
 * Updates a quiz. Before anyone has started it, questions are replaced freely. After that the question and
 * choice ids are fixed (attempts reference them), so only wording, points and answer keys may change, and
 * submitted attempts are re-graded against the new key in the same transaction.
 */
export async function updateQuiz(id: number, dto: QuizDto) {
  checkQuestions(dto.questions);
  return prisma.$transaction(async (tx) => {
    const quiz = await tx.quiz.findUnique({ where: { id }, select: { id: true, itemsPerStudent: true } });
    if (!quiz) throw notFound('Quiz not found');
    await assertSubject(tx, dto.subjectId);
    const itemsPerStudent = dto.itemsPerStudent === undefined ? quiz.itemsPerStudent : dto.itemsPerStudent;
    checkItemsPerStudent(itemsPerStudent, dto.questions.length);

    const locked = (await attemptCount(tx, id)) > 0;
    const quizFields = {
      subjectId: dto.subjectId,
      title: dto.title.trim(),
      timeLimitMinutes: dto.timeLimitMinutes,
      shuffleQuestions: dto.shuffleQuestions,
      shuffleChoices: dto.shuffleChoices,
      showResultsToStudents: dto.showResultsToStudents,
      ...(dto.secureMode !== undefined ? { secureMode: dto.secureMode } : {}),
      ...(dto.maxViolations !== undefined ? { maxViolations: dto.maxViolations } : {}),
      itemsPerStudent,
      totalPoints: totalPoints(dto.questions),
    };

    if (!locked) {
      await tx.question.deleteMany({ where: { quizId: id } });
      await tx.quiz.update({
        where: { id },
        data: { ...quizFields, questions: { create: dto.questions.map((q, i) => questionCreateData(q, i)) } },
      });
      return { id, regraded: 0 };
    }

    const existing = await tx.question.findMany({
      where: { quizId: id },
      include: { choices: { select: { id: true } } },
    });
    const lockedMsg =
      'Students have already started this quiz, so questions and choices cannot be added, removed or change type. ' +
      'You can still edit wording, points, the correct choice and accepted answers.';
    const byId = new Map(existing.map((q) => [q.id, q]));
    if (dto.questions.length !== existing.length || dto.questions.some((q) => !q.id || !byId.has(q.id))) {
      throw conflict(lockedMsg, 'QUIZ_LOCKED');
    }
    if (dto.subjectId !== (await tx.quiz.findUniqueOrThrow({ where: { id } })).subjectId) {
      throw conflict('The subject cannot change after students have started this quiz.', 'QUIZ_LOCKED');
    }
    if (itemsPerStudent !== quiz.itemsPerStudent) {
      throw conflict('Items per student cannot change after students have started this quiz.', 'QUIZ_LOCKED');
    }

    for (const [position, q] of dto.questions.entries()) {
      const old = byId.get(q.id!)!;
      if (old.type !== q.type) throw conflict(lockedMsg, 'QUIZ_LOCKED');
      await tx.question.update({ where: { id: old.id }, data: { text: q.text.trim(), points: q.points, position } });

      if (q.type === 'multiple_choice') {
        const oldIds = new Set(old.choices.map((c) => c.id));
        if (q.choices!.some((c) => !c.id || !oldIds.has(c.id)) || q.choices!.length !== oldIds.size) {
          throw conflict(lockedMsg, 'QUIZ_LOCKED');
        }
        await tx.choice.updateMany({ where: { questionId: old.id }, data: { isCorrect: false } });
        for (const [i, c] of q.choices!.entries()) {
          await tx.choice.update({ where: { id: c.id! }, data: { text: c.text.trim(), isCorrect: c.isCorrect, position: i } });
        }
      } else {
        await tx.acceptedAnswer.deleteMany({ where: { questionId: old.id } });
        await tx.acceptedAnswer.createMany({
          data: [...new Set(q.acceptedAnswers!.map((a) => a.trim()).filter(Boolean))].map((answerText) => ({ questionId: old.id, answerText })),
        });
      }
    }

    await tx.quiz.update({ where: { id }, data: quizFields });
    const regraded = await regradeQuiz(tx, id);
    return { id, regraded };
  }, LONG_TX);
}

export async function deleteQuiz(id: number) {
  const quiz = await prisma.quiz.findUnique({ where: { id }, include: { _count: { select: { assignments: true } } } });
  if (!quiz) throw notFound('Quiz not found');
  if (quiz._count.assignments > 0) throw conflict('Remove this quiz from all sections before deleting it.', 'QUIZ_ASSIGNED');
  await prisma.quiz.delete({ where: { id } });
}

/** Imports one or more whole quizzes from parsed JSON. All-or-nothing. */
export async function importQuizzes(data: unknown) {
  const subjects = await subjectLookup();
  const list = quizList(data);
  if (list.length === 0) throw badRequest('No quizzes found in the file');
  const dtos: QuizDto[] = [];
  for (const [i, raw] of list.entries()) dtos.push(await normalizeQuiz(raw, subjects, i));
  dtos.forEach((d) => checkQuestions(d.questions));

  const created = await prisma.$transaction(async (tx) => {
    const out: { id: number; title: string; questions: number; totalPoints: number }[] = [];
    for (const dto of dtos) {
      const { id } = await createQuiz(dto, tx);
      out.push({ id, title: dto.title, questions: dto.questions.length, totalPoints: totalPoints(dto.questions) });
    }
    return out;
  }, LONG_TX);
  return { created };
}
