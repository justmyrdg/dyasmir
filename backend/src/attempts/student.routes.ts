import { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { body, intParam } from '../lib/validate';
import { RecordEventsDto, ReopenRequestDto, SaveAttemptDto, StartAttemptDto } from './attempts.dto';
import * as attempts from './attempts.service';
import { recordDevice } from './device';

// Student-only endpoints. Every query is scoped to req.user (own attempts, own section).

/** Mounted at /api/student */
export const studentRouter = Router();
studentRouter.use(requireAuth, requireRole('student'));

studentRouter.get('/assignments', async (req, res) => {
  res.json(await attempts.listAssignmentsForStudent(currentUser(req)));
});

/** Mounted at /api/attempts */
export const attemptsRouter = Router();
attemptsRouter.use(requireAuth, requireRole('student'));

attemptsRouter.post('/start', body(StartAttemptDto), async (req, res) => {
  const { attemptId, created } = await attempts.startAttempt(currentUser(req), req.body.assignmentId);
  await recordDevice(req, currentUser(req), attemptId);
  res.status(created ? 201 : 200).json(await attempts.getAttemptForStudent(currentUser(req), attemptId));
});

attemptsRouter.get('/:id', async (req, res) => {
  const view = await attempts.getAttemptForStudent(currentUser(req), intParam(req.params.id));
  await recordDevice(req, currentUser(req), view.id);
  res.json(view);
});

attemptsRouter.post('/:id/save', body(SaveAttemptDto), async (req, res) => {
  const id = intParam(req.params.id);
  await recordDevice(req, currentUser(req), id); // before saving, which may submit the attempt
  res.json(await attempts.saveProgress(currentUser(req), id, req.body));
});

/** Exam-security events (left the page, screenshot key, blocked copy/paste, ...). May submit the attempt. */
attemptsRouter.post('/:id/events', body(RecordEventsDto), async (req, res) => {
  const id = intParam(req.params.id);
  await recordDevice(req, currentUser(req), id);
  res.json(await attempts.recordEvents(currentUser(req), id, req.body));
});

/** Exam submitted for leaving it too many times: ask the teacher to reopen it (end time unchanged). */
attemptsRouter.get('/:id/reopen-request', async (req, res) => {
  res.json(await attempts.getReopenRequest(currentUser(req), intParam(req.params.id)));
});

attemptsRouter.post('/:id/reopen-request', body(ReopenRequestDto), async (req, res) => {
  const { created, state } = await attempts.requestReopen(currentUser(req), intParam(req.params.id), req.body);
  res.status(created ? 201 : 200).json(state);
});

attemptsRouter.post('/:id/submit', async (req, res) => {
  res.json(await attempts.submitAttempt(currentUser(req), intParam(req.params.id)));
});

attemptsRouter.get('/:id/result', async (req, res) => {
  res.json(await attempts.getResultForStudent(currentUser(req), intParam(req.params.id)));
});
