import { Router } from 'express';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { prisma } from '../db';
import { badRequest } from '../lib/http-error';
import { body, intParam, optionalIntQuery } from '../lib/validate';
import * as assignments from './assignments.service';
import { normalizeQuestionList } from './quiz-import';
import * as quizzes from './quizzes.service';
import * as reports from './reports.service';
import * as students from './students.service';
import {
  CreateStudentDto,
  ImportJsonDto,
  ImportStudentsDto,
  QuizDto,
  RecheckDto,
  ReopenAttemptDto,
  ResetPasswordDto,
  UpdateAssignmentDto,
  UpdateStudentDto,
  UpsertAssignmentsDto,
} from './teacher.dto';

/** Mounted at /api/teacher. Every route requires the teacher role. */
export const teacherRouter = Router();
teacherRouter.use(requireAuth, requireRole('teacher'));

teacherRouter.get('/meta', async (_req, res) => {
  const [sections, subjects] = await Promise.all([
    prisma.section.findMany({ orderBy: { name: 'asc' } }),
    prisma.subject.findMany({ orderBy: { name: 'asc' } }),
  ]);
  res.json({ sections, subjects });
});

// ---- Dashboard & results ----
teacherRouter.get('/dashboard', async (_req, res) => {
  res.json(await reports.dashboard());
});

function resultsFilter(query: Record<string, unknown>): reports.ResultsFilter {
  return {
    sectionId: optionalIntQuery(query.sectionId, 'sectionId'),
    subjectId: optionalIntQuery(query.subjectId, 'subjectId'),
    quizId: optionalIntQuery(query.quizId, 'quizId'),
  };
}

teacherRouter.get('/results', async (req, res) => {
  res.json(await reports.results(resultsFilter(req.query)));
});

teacherRouter.get('/results/export', async (req, res) => {
  const format = String(req.query.format ?? 'xlsx');
  if (format !== 'csv' && format !== 'xlsx') throw badRequest('format must be csv or xlsx');
  const rows = await reports.results(resultsFilter(req.query));
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="quiz-results-${stamp}.csv"`);
    res.send(reports.resultsCsv(rows));
  } else {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="quiz-results-${stamp}.xlsx"`);
    res.send(await reports.resultsXlsx(rows));
  }
});

teacherRouter.get('/attempts/:id', async (req, res) => {
  res.json(await reports.attemptDetail(intParam(req.params.id)));
});

/** Re-check one item: { correct: true | false | null }. */
teacherRouter.put('/attempts/:id/items/:questionId', body(RecheckDto), async (req, res) => {
  res.json(await reports.recheckItem(intParam(req.params.id), intParam(req.params.questionId, 'questionId'), req.body.correct));
});

/** Let a student revise a submitted attempt: { minutes }. */
teacherRouter.post('/attempts/:id/reopen', body(ReopenAttemptDto), async (req, res) => {
  res.json(await reports.reopenAttempt(intParam(req.params.id), req.body.minutes));
});

teacherRouter.delete('/attempts/:id', async (req, res) => {
  await reports.resetAttempt(intParam(req.params.id));
  res.status(204).end();
});

// ---- Students ----
teacherRouter.get('/students', async (req, res) => {
  res.json(
    await students.listStudents({
      sectionId: optionalIntQuery(req.query.sectionId, 'sectionId'),
      subjectId: optionalIntQuery(req.query.subjectId, 'subjectId'),
      search: typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : undefined,
    }),
  );
});

teacherRouter.post('/students', body(CreateStudentDto), async (req, res) => {
  res.status(201).json(await students.createStudent(req.body));
});

teacherRouter.post('/students/import', body(ImportStudentsDto), async (req, res) => {
  res.json(await students.importStudents(req.body));
});

/** Excel template for importing students (sections and subjects filled in from the database). */
teacherRouter.get('/students/template', async (_req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="JASthinkAboutIT-students-template.xlsx"');
  res.send(await students.studentsTemplate());
});

teacherRouter.patch('/students/:id', body(UpdateStudentDto), async (req, res) => {
  res.json(await students.updateStudent(intParam(req.params.id), req.body));
});

teacherRouter.post('/students/:id/reset-password', body(ResetPasswordDto), async (req, res) => {
  await students.resetPassword(intParam(req.params.id), req.body.password);
  res.status(204).end();
});

// ---- Quizzes ----
teacherRouter.get('/quizzes', async (_req, res) => {
  res.json(await quizzes.listQuizzes());
});

teacherRouter.post('/quizzes', body(QuizDto), async (req, res) => {
  const { id } = await quizzes.createQuiz(req.body);
  res.status(201).json(await quizzes.getQuiz(id));
});

teacherRouter.post('/quizzes/import', body(ImportJsonDto), async (req, res) => {
  res.status(201).json(await quizzes.importQuizzes(req.body.data));
});

/** Parses a questions JSON file for the editor without saving anything. */
teacherRouter.post('/quizzes/parse-questions', body(ImportJsonDto), async (req, res) => {
  res.json({ questions: await normalizeQuestionList(req.body.data) });
});

teacherRouter.get('/quizzes/:id', async (req, res) => {
  res.json(await quizzes.getQuiz(intParam(req.params.id)));
});

teacherRouter.put('/quizzes/:id', body(QuizDto), async (req, res) => {
  const id = intParam(req.params.id);
  const { regraded } = await quizzes.updateQuiz(id, req.body);
  res.json({ ...(await quizzes.getQuiz(id)), regraded });
});

teacherRouter.delete('/quizzes/:id', async (req, res) => {
  await quizzes.deleteQuiz(intParam(req.params.id));
  res.status(204).end();
});

// ---- Assignments (schedules per section) ----
teacherRouter.get('/quizzes/:id/assignments', async (req, res) => {
  res.json(await assignments.listForQuiz(intParam(req.params.id)));
});

teacherRouter.put('/quizzes/:id/assignments', body(UpsertAssignmentsDto), async (req, res) => {
  res.json(await assignments.upsertForQuiz(intParam(req.params.id), req.body.items));
});

teacherRouter.patch('/assignments/:id', body(UpdateAssignmentDto), async (req, res) => {
  res.json(await assignments.updateAssignment(intParam(req.params.id), req.body));
});

teacherRouter.delete('/assignments/:id', async (req, res) => {
  res.json(await assignments.deleteAssignment(intParam(req.params.id)));
});
