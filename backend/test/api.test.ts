import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { autoSubmitExpired } from '../src/attempts/grading';
import { prisma } from '../src/db';
import { hashPassword } from '../src/lib/passwords';

const app = createApp();
const PW = 'secret123';

let sectionA: number;
let sectionB: number;
let subjectId: number;
let embeddedId: number;
let teacherToken: string;
let quizId: number;
let assignmentA: number;
let assignmentB: number;

async function login(body: Record<string, string>) {
  return request(app).post('/api/auth/login').send(body);
}

async function studentToken(srCode: string) {
  const res = await login({ srCode, password: PW });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Offsets relative to the DB clock, as ISO strings with +08:00 like the frontend sends. */
async function dbIso(offsetMinutes: number): Promise<string> {
  const [{ t }] = await prisma.$queryRaw<{ t: Date }[]>`SELECT now() + make_interval(mins => ${offsetMinutes}::int) AS t`;
  const manila = new Date(t.getTime() + 8 * 3600_000).toISOString().slice(0, 19);
  return `${manila}+08:00`;
}

const quizJson = {
  quizzes: [
    {
      subject: 'Database Design',
      title: 'Test Quiz',
      timeLimitMinutes: 30,
      shuffleQuestions: true,
      shuffleChoices: true,
      showResultsToStudents: true,
      questions: [
        { type: 'multiple_choice', text: 'Which key uniquely identifies a row?', points: 1, choices: ['Foreign key', 'Primary key', 'Index', 'View'], answer: 1 },
        { type: 'multiple_choice', text: 'SQL keyword to remove rows?', points: 1, choices: ['DROP', 'REMOVE', 'DELETE', 'ERASE'], answer: 'DELETE' },
        { type: 'identification', text: 'Normal form that removes partial dependencies?', points: 2, acceptedAnswers: ['2NF', 'Second Normal Form'] },
      ],
    },
  ],
};

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE attempt_answers, attempts, assignments, accepted_answers, choices, questions, quizzes, refresh_tokens, users RESTART IDENTITY CASCADE',
  );
  const sections = await prisma.section.findMany();
  sectionA = sections.find((s) => s.name === 'BCpET3101')!.id;
  sectionB = sections.find((s) => s.name === 'BCpET3102')!.id;
  subjectId = (await prisma.subject.findUniqueOrThrow({ where: { name: 'Database Design' } })).id;
  embeddedId = (await prisma.subject.findUniqueOrThrow({ where: { name: 'Embedded Systems (CpET343)' } })).id;

  const hash = await hashPassword(PW);
  await prisma.user.create({ data: { role: 'teacher', email: 'teacher@test.local', name: 'Teacher', passwordHash: await hashPassword('teacherpw1') } });
  await prisma.user.createMany({
    data: [
      { role: 'student', srCode: '23-00001', name: 'Ana A', sectionId: sectionA, passwordHash: hash },
      { role: 'student', srCode: '23-00002', name: 'Ben A', sectionId: sectionA, passwordHash: hash },
      { role: 'student', srCode: '23-00003', name: 'Cora B', sectionId: sectionB, passwordHash: hash },
      { role: 'student', srCode: '23-00009', name: 'Lock Me', sectionId: sectionB, passwordHash: hash },
      { role: 'student', srCode: '23-00004', name: 'Dina A (Embedded only)', sectionId: sectionA, passwordHash: hash },
    ],
  });
  // Everyone takes both subjects except Dina, who only takes Embedded Systems.
  const students = await prisma.user.findMany({ where: { role: 'student' } });
  await prisma.studentSubject.createMany({
    data: students.flatMap((s) =>
      (s.srCode === '23-00004' ? [embeddedId] : [subjectId, embeddedId]).map((sid) => ({ studentId: s.id, subjectId: sid, sectionId: s.sectionId! })),
    ),
  });

  const t = await login({ email: 'teacher@test.local', password: 'teacherpw1' });
  expect(t.status).toBe(200);
  teacherToken = t.body.accessToken;

  const imp = await request(app).post('/api/teacher/quizzes/import').set(auth(teacherToken)).send({ data: quizJson });
  expect(imp.status).toBe(201);
  quizId = imp.body.created[0].id;

  const asg = await request(app)
    .put(`/api/teacher/quizzes/${quizId}/assignments`)
    .set(auth(teacherToken))
    .send({
      items: [
        { sectionId: sectionA, startAt: await dbIso(-5), dueAt: await dbIso(60) },
        { sectionId: sectionB, startAt: await dbIso(60), dueAt: await dbIso(120) },
      ],
    });
  expect(asg.status).toBe(200);
  assignmentA = asg.body.sections.find((s: { sectionId: number }) => s.sectionId === sectionA).assignment.id;
  assignmentB = asg.body.sections.find((s: { sectionId: number }) => s.sectionId === sectionB).assignment.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('auth', () => {
  it('rejects a malformed SR code with 400', async () => {
    const res = await login({ srCode: '2300001', password: PW });
    expect(res.status).toBe(400);
  });

  it('rejects a wrong password with 401 and locks after 5 failures', async () => {
    for (let i = 0; i < 4; i++) expect((await login({ srCode: '23-00009', password: 'nope' })).status).toBe(401);
    expect((await login({ srCode: '23-00009', password: 'nope' })).status).toBe(423);
    // Even the right password is refused while locked.
    expect((await login({ srCode: '23-00009', password: PW })).status).toBe(423);
  });

  it('a student cannot log in through the teacher form and vice versa', async () => {
    expect((await login({ email: 'teacher@test.local', password: PW })).status).toBe(401);
  });

  it('sets an httpOnly refresh cookie and rotates it on refresh', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ srCode: '23-00001', password: PW });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/qp_rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    const r1 = await agent.post('/api/auth/refresh');
    expect(r1.status).toBe(200);
    expect(r1.body.user.srCode).toBe('23-00001');
    expect(String(r1.headers['set-cookie'])).toMatch(/qp_rt=/);
  });

  it('students are refused on teacher endpoints', async () => {
    const t = await studentToken('23-00001');
    expect((await request(app).get('/api/teacher/students').set(auth(t))).status).toBe(403);
    expect((await request(app).post('/api/teacher/students').set(auth(t)).send({})).status).toBe(403);
  });

  it('teacher is refused on student endpoints, anonymous gets 401', async () => {
    expect((await request(app).get('/api/student/assignments').set(auth(teacherToken))).status).toBe(403);
    expect((await request(app).get('/api/student/assignments')).status).toBe(401);
  });
});

describe('student flow', () => {
  let tokenAna: string;
  let attemptId: number;
  let firstOrder: number[];

  beforeAll(async () => {
    tokenAna = await studentToken('23-00001');
  });

  it('dashboard shows only own section with server-computed status', async () => {
    const a = await request(app).get('/api/student/assignments').set(auth(tokenAna));
    expect(a.status).toBe(200);
    expect(a.body.items).toHaveLength(1);
    expect(a.body.items[0].status).toBe('open');

    const tCora = await studentToken('23-00003');
    const b = await request(app).get('/api/student/assignments').set(auth(tCora));
    expect(b.body.items[0].status).toBe('not_yet_open');
    expect((await request(app).post('/api/attempts/start').set(auth(tCora)).send({ assignmentId: assignmentB })).status).toBe(409);
    // Cannot start another section's quiz.
    expect((await request(app).post('/api/attempts/start').set(auth(tCora)).send({ assignmentId: assignmentA })).status).toBe(404);
  });

  it('start creates once; starting again returns the same order', async () => {
    const r1 = await request(app).post('/api/attempts/start').set(auth(tokenAna)).send({ assignmentId: assignmentA });
    expect(r1.status).toBe(201);
    attemptId = r1.body.id;
    firstOrder = r1.body.questions.map((q: { id: number }) => q.id);
    const firstChoices = r1.body.questions.map((q: { choices: { id: number }[] }) => q.choices.map((c) => c.id));

    const r2 = await request(app).post('/api/attempts/start').set(auth(tokenAna)).send({ assignmentId: assignmentA });
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(attemptId);
    expect(r2.body.questions.map((q: { id: number }) => q.id)).toEqual(firstOrder);
    expect(r2.body.questions.map((q: { choices: { id: number }[] }) => q.choices.map((c) => c.id))).toEqual(firstChoices);
    expect(new Date(r2.body.deadline).getTime()).toBeGreaterThan(new Date(r2.body.serverNow).getTime());
  });

  it('never sends answer keys to the student', async () => {
    const r = await request(app).get(`/api/attempts/${attemptId}`).set(auth(tokenAna));
    const raw = JSON.stringify(r.body);
    expect(raw).not.toMatch(/isCorrect|is_correct|accepted|Second Normal Form|2NF/i);
  });

  it('autosaves answers and position; resume restores them', async () => {
    const att = await prisma.attempt.findUniqueOrThrow({ where: { id: attemptId } });
    const quiz = await prisma.question.findMany({ where: { quizId }, include: { choices: true } });
    const pk = quiz.find((q) => q.text.startsWith('Which key'))!;
    const pkCorrect = pk.choices.find((c) => c.isCorrect)!.id;
    const del = quiz.find((q) => q.text.startsWith('SQL keyword'))!;
    const delWrong = del.choices.find((c) => !c.isCorrect)!.id;
    const ident = quiz.find((q) => q.type === 'identification')!;

    const save = await request(app)
      .post(`/api/attempts/${attemptId}/save`)
      .set(auth(tokenAna))
      .send({
        answers: [
          { questionId: pk.id, answer: String(pkCorrect) },
          { questionId: del.id, answer: String(delWrong) },
          { questionId: ident.id, answer: '  second   NORMAL form ' },
        ],
        currentIndex: 2,
      });
    expect(save.status).toBe(200);

    // Invalid choice id, foreign question, and tampering fields are rejected.
    expect(
      (await request(app).post(`/api/attempts/${attemptId}/save`).set(auth(tokenAna)).send({ answers: [{ questionId: pk.id, answer: '999999' }] })).status,
    ).toBe(400);
    expect(
      (await request(app).post(`/api/attempts/${attemptId}/save`).set(auth(tokenAna)).send({ answers: [{ questionId: 999999, answer: 'x' }] })).status,
    ).toBe(400);
    expect((await request(app).post(`/api/attempts/${attemptId}/save`).set(auth(tokenAna)).send({ score: 100 })).status).toBe(400);
    expect((await request(app).post(`/api/attempts/${attemptId}/save`).set(auth(tokenAna)).send({ questionOrder: [] })).status).toBe(400);

    const resumed = await request(app).get(`/api/attempts/${attemptId}`).set(auth(tokenAna));
    expect(resumed.body.currentIndex).toBe(2);
    expect(resumed.body.answers[String(pk.id)]).toBe(String(pkCorrect));
    expect(resumed.body.questions.map((q: { id: number }) => q.id)).toEqual(firstOrder);
    expect(new Date(resumed.body.startedAt).getTime()).toBe(att.startedAt.getTime());
  });

  it('other students cannot read or write this attempt', async () => {
    const tBen = await studentToken('23-00002');
    expect((await request(app).get(`/api/attempts/${attemptId}`).set(auth(tBen))).status).toBe(404);
    expect((await request(app).post(`/api/attempts/${attemptId}/save`).set(auth(tBen)).send({ currentIndex: 0 })).status).toBe(404);
    expect((await request(app).post(`/api/attempts/${attemptId}/submit`).set(auth(tBen))).status).toBe(404);
  });

  it('grades on submit (case-insensitive, trimmed identification) and locks the attempt', async () => {
    const res = await request(app).post(`/api/attempts/${attemptId}/submit`).set(auth(tokenAna));
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(3); // 1 (MC right) + 0 (MC wrong) + 2 (identification right)
    expect(res.body.totalPoints).toBe(4);
    expect(res.body.items).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toMatch(/2NF/); // feedback never reveals keys

    const again = await request(app).post(`/api/attempts/${attemptId}/save`).set(auth(tokenAna)).send({ currentIndex: 0 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ATTEMPT_SUBMITTED');

    const dash = await request(app).get('/api/student/assignments').set(auth(tokenAna));
    expect(dash.body.items[0].status).toBe('submitted');
  });
});

describe('deadlines use the database clock', () => {
  it('rejects saves after the deadline and the job auto-submits', async () => {
    const tBen = await studentToken('23-00002');
    const start = await request(app).post('/api/attempts/start').set(auth(tBen)).send({ assignmentId: assignmentA });
    expect(start.status).toBe(201);
    const id = start.body.id;
    const q = start.body.questions.find((x: { type: string }) => x.type === 'multiple_choice');
    await request(app)
      .post(`/api/attempts/${id}/save`)
      .set(auth(tBen))
      .send({ answers: [{ questionId: q.id, answer: String(q.choices[0].id) }] })
      .expect(200);

    // Simulate the time limit passing.
    await prisma.$executeRaw`UPDATE attempts SET started_at = now() - interval '31 minutes' WHERE id = ${id}`;
    expect(await autoSubmitExpired()).toBe(1);
    const row = await prisma.attempt.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('submitted');
    expect(row.score).not.toBeNull();

    const late = await request(app).post(`/api/attempts/${id}/save`).set(auth(tBen)).send({ currentIndex: 1 });
    expect(late.status).toBe(409);
  });

  it('teacher can extend a section deadline; closed quizzes cannot be started', async () => {
    const res = await request(app)
      .patch(`/api/teacher/assignments/${assignmentB}`)
      .set(auth(teacherToken))
      .send({ startAt: await dbIso(-120), dueAt: await dbIso(-60) });
    expect(res.status).toBe(200);
    const tCora = await studentToken('23-00003');
    const dash = await request(app).get('/api/student/assignments').set(auth(tCora));
    expect(dash.body.items[0].status).toBe('closed');
    const start = await request(app).post('/api/attempts/start').set(auth(tCora)).send({ assignmentId: assignmentB });
    expect(start.status).toBe(409);
    expect(start.body.code).toBe('CLOSED');

    // due_at must be after start_at
    const bad = await request(app)
      .patch(`/api/teacher/assignments/${assignmentB}`)
      .set(auth(teacherToken))
      .send({ startAt: await dbIso(10), dueAt: await dbIso(5) });
    expect(bad.status).toBe(400);
  });
});

describe('teacher features', () => {
  it('imports students from CSV all-or-nothing and skips existing SR codes', async () => {
    const bad = await request(app)
      .post('/api/teacher/students/import')
      .set(auth(teacherToken))
      .send({
        csv: 'srCode,name,section,password,subjects\n23-10001,New One,BCpET3101,pass123,\n2310002,Bad Code,BCpET3101,pass123,\n23-10003,Old Section,A,pass123,\n23-10004,Bad Subject,BCpET3101,pass123,Physics\n',
      });
    expect(bad.status).toBe(400);
    expect(bad.body.details.map((d: { line: number }) => d.line)).toEqual([3, 4, 5]);
    expect(await prisma.user.count({ where: { srCode: '23-10001' } })).toBe(0);

    const ok = await request(app)
      .post('/api/teacher/students/import')
      .set(auth(teacherToken))
      .send({
        csv: 'srCode,name,section,password,subjects\n23-10001,New One,BCpET3101,pass123,\n23-00001,Ana Again,BCpET3101,pass123,\n"23-10002","Dela Cruz, Juan",3103,pass456,CpET343\n',
      });
    expect(ok.status).toBe(200);
    expect(ok.body.created).toBe(2);
    expect(ok.body.skipped).toEqual(['23-00001']);
    expect((await login({ srCode: '23-10002', password: 'pass456' })).status).toBe(200);

    // Empty subjects cell = every subject of the section; "CpET343" = Embedded Systems only; "3103" = BCpET3103.
    const enrolled = async (sr: string) =>
      (await prisma.studentSubject.findMany({ where: { student: { srCode: sr } }, orderBy: { subjectId: 'asc' } })).map((e) => e.subjectId);
    expect(await enrolled('23-10001')).toEqual([subjectId, embeddedId].sort((a, b) => a - b));
    expect(await enrolled('23-10002')).toEqual([embeddedId]);
    expect((await prisma.user.findUniqueOrThrow({ where: { srCode: '23-10002' }, include: { section: true } })).section!.name).toBe('BCpET3103');
  });

  it('resets passwords and deactivates students', async () => {
    const s = await prisma.user.findUniqueOrThrow({ where: { srCode: '23-10001' } });
    await request(app).post(`/api/teacher/students/${s.id}/reset-password`).set(auth(teacherToken)).send({ password: 'newpass1' }).expect(204);
    const t = await login({ srCode: '23-10001', password: 'newpass1' });
    expect(t.status).toBe(200);

    await request(app).patch(`/api/teacher/students/${s.id}`).set(auth(teacherToken)).send({ isActive: false }).expect(200);
    expect((await login({ srCode: '23-10001', password: 'newpass1' })).status).toBe(403);
    // Existing access token stops working immediately.
    expect((await request(app).get('/api/student/assignments').set(auth(t.body.accessToken))).status).toBe(401);
  });

  it('results table and exports', async () => {
    const r = await request(app).get(`/api/teacher/results?quizId=${quizId}&sectionId=${sectionA}`).set(auth(teacherToken));
    expect(r.status).toBe(200);
    const ana = r.body.find((x: { srCode: string }) => x.srCode === '23-00001');
    expect(ana.status).toBe('submitted');
    expect(ana.score).toBe(3);

    const csv = await request(app).get(`/api/teacher/results/export?format=csv&quizId=${quizId}`).set(auth(teacherToken));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('SR Code,Name,Section');
    expect(csv.text).toContain('23-00001');

    const xlsx = await request(app).get(`/api/teacher/results/export?format=xlsx`).set(auth(teacherToken)).buffer(true);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
  });

  it('dashboard aggregates per section and subject', async () => {
    const d = await request(app).get('/api/teacher/dashboard').set(auth(teacherToken));
    expect(d.status).toBe(200);
    const aDb = d.body.stats.find((s: { section: string; subjectId: number }) => s.section === 'BCpET3101' && s.subjectId === subjectId);
    expect(aDb.submitted).toBe(2);
    // Active in BCpET3101: Ana, Ben, Dina (Embedded Systems only). 23-10001 was deactivated earlier.
    expect(aDb.students).toBe(2);
    expect(aDb.sectionStudents).toBe(3);
    expect(d.body.stats).toHaveLength(6);
  });

  it('locks quiz structure once started, but fixing a key re-grades', async () => {
    const quiz = (await request(app).get(`/api/teacher/quizzes/${quizId}`).set(auth(teacherToken))).body;
    expect(quiz.structureLocked).toBe(true);
    const payload = {
      subjectId: quiz.subjectId,
      title: quiz.title,
      timeLimitMinutes: quiz.timeLimitMinutes,
      shuffleQuestions: quiz.shuffleQuestions,
      shuffleChoices: quiz.shuffleChoices,
      showResultsToStudents: quiz.showResultsToStudents,
      questions: quiz.questions,
    };

    const add = await request(app)
      .put(`/api/teacher/quizzes/${quizId}`)
      .set(auth(teacherToken))
      .send({ ...payload, questions: [...quiz.questions, { type: 'identification', text: 'New?', points: 1, acceptedAnswers: ['x'] }] });
    expect(add.status).toBe(409);

    // Accept "2 NF" as well -> nothing changes for Ana; then make the DELETE question's key "DROP" -> Ana's score changes.
    const del = payload.questions.find((q: { text: string }) => q.text.startsWith('SQL keyword'));
    const anaAttempt = await prisma.attempt.findFirstOrThrow({ where: { student: { srCode: '23-00001' } }, include: { answers: true } });
    const anaDelAnswer = anaAttempt.answers.find((a) => a.questionId === del.id)!.answer;
    for (const c of del.choices) c.isCorrect = String(c.id) === anaDelAnswer;

    const upd = await request(app).put(`/api/teacher/quizzes/${quizId}`).set(auth(teacherToken)).send(payload);
    expect(upd.status).toBe(200);
    expect(upd.body.regraded).toBeGreaterThanOrEqual(1);
    const after = await prisma.attempt.findUniqueOrThrow({ where: { id: anaAttempt.id } });
    expect(after.score).toBe(4);
  });

  it('database rejects a multiple-choice question with two correct choices', async () => {
    const q = await prisma.question.findFirstOrThrow({ where: { quizId, type: 'multiple_choice' }, include: { choices: true } });
    await expect(prisma.choice.updateMany({ where: { questionId: q.id }, data: { isCorrect: true } })).rejects.toThrow();
  });
});

describe('subject enrollment', () => {
  let dina: { id: number };
  let tokenDina: string;

  beforeAll(async () => {
    dina = await prisma.user.findUniqueOrThrow({ where: { srCode: '23-00004' } });
    tokenDina = await studentToken('23-00004');
  });

  it('a student not enrolled in the subject does not see or start its quiz', async () => {
    const dash = await request(app).get('/api/student/assignments').set(auth(tokenDina));
    expect(dash.status).toBe(200);
    expect(dash.body.items).toHaveLength(0);
    const start = await request(app).post('/api/attempts/start').set(auth(tokenDina)).send({ assignmentId: assignmentA });
    expect(start.status).toBe(404);
  });

  it('results leave out students who do not take the subject', async () => {
    const r = await request(app).get(`/api/teacher/results?quizId=${quizId}&sectionId=${sectionA}`).set(auth(teacherToken));
    expect(r.body.map((x: { srCode: string }) => x.srCode)).not.toContain('23-00004');
    const asg = await request(app).get(`/api/teacher/quizzes/${quizId}/assignments`).set(auth(teacherToken));
    expect(asg.body.sections.find((s: { sectionId: number }) => s.sectionId === sectionA).students).toBe(2);
  });

  it('teacher can change a student’s subjects', async () => {
    const list = await request(app).get(`/api/teacher/students?subjectId=${embeddedId}&sectionId=${sectionA}`).set(auth(teacherToken));
    const row = list.body.find((s: { srCode: string }) => s.srCode === '23-00004');
    expect(row.subjects.map((s: { id: number }) => s.id)).toEqual([embeddedId]);

    expect((await request(app).patch(`/api/teacher/students/${dina.id}`).set(auth(teacherToken)).send({ enrollments: [{ subjectId: 99999, sectionId: sectionA }] })).status).toBe(400);

    const upd = await request(app).patch(`/api/teacher/students/${dina.id}`).set(auth(teacherToken)).send({ enrollments: [{ subjectId, sectionId: sectionA }, { subjectId: embeddedId, sectionId: sectionA }] });
    expect(upd.status).toBe(200);
    expect(upd.body.subjects).toHaveLength(2);
    const dash = await request(app).get('/api/student/assignments').set(auth(tokenDina));
    expect(dash.body.items).toHaveLength(1);
    expect(dash.body.items[0].status).toBe('open');

    await request(app).patch(`/api/teacher/students/${dina.id}`).set(auth(teacherToken)).send({ enrollments: [] }).expect(200);
    expect((await request(app).get('/api/student/assignments').set(auth(tokenDina))).body.items).toHaveLength(0);
  });

  it('new students default to every subject of their section', async () => {
    const res = await request(app)
      .post('/api/teacher/students')
      .set(auth(teacherToken))
      .send({ srCode: '23-20001', name: 'Default Subjects', sectionId: sectionB, password: 'pass123' });
    expect(res.status).toBe(201);
    expect(res.body.subjects).toHaveLength(2);
    const only = await request(app)
      .post('/api/teacher/students')
      .set(auth(teacherToken))
      .send({ srCode: '23-20002', name: 'Only DB', sectionId: sectionB, password: 'pass123', enrollments: [{ subjectId, sectionId: sectionB }] });
    expect(only.body.subjects.map((s: { name: string }) => s.name)).toEqual(['Database Design']);
  });

  it('the database refuses enrollments for teachers', async () => {
    const teacher = await prisma.user.findFirstOrThrow({ where: { role: 'teacher' } });
    await expect(prisma.studentSubject.create({ data: { studentId: teacher.id, subjectId, sectionId: sectionA } })).rejects.toThrow();
  });
});

describe('teacher re-check (consideration)', () => {
  type Item = { questionId: number; type: string; points: number; answer: string | null; isCorrect: boolean; pointsAwarded: number; autoCorrect: boolean | null; overridden: boolean };
  let attemptId: number;
  const detail = async () => (await request(app).get(`/api/teacher/attempts/${attemptId}`).set(auth(teacherToken))).body as { score: number; items: Item[] };
  const recheck = (questionId: number, correct: boolean | null) =>
    request(app).put(`/api/teacher/attempts/${attemptId}/items/${questionId}`).set(auth(teacherToken)).send({ correct });

  beforeAll(async () => {
    // Ben's attempt was auto-submitted with a single multiple-choice answer.
    attemptId = (await prisma.attempt.findFirstOrThrow({ where: { student: { srCode: '23-00002' }, assignmentId: assignmentA } })).id;
  });

  it('gives full points for a blank identification item and can be undone', async () => {
    const before = await detail();
    const ident = before.items.find((i) => i.type === 'identification')!;
    expect(ident.answer).toBeNull();

    const on = await recheck(ident.questionId, true);
    expect(on.status).toBe(200);
    const item = on.body.items.find((i: Item) => i.questionId === ident.questionId);
    expect(item).toMatchObject({ isCorrect: true, pointsAwarded: ident.points, autoCorrect: false, overridden: true, answer: null });
    expect(on.body.score).toBe(before.score + ident.points);

    const off = await recheck(ident.questionId, null);
    expect(off.body.score).toBe(before.score);
    expect(off.body.items.find((i: Item) => i.questionId === ident.questionId).overridden).toBe(false);
    expect(await prisma.attemptAnswer.count({ where: { attemptId, questionId: ident.questionId } })).toBe(0);
  });

  it('flips an answered multiple-choice item either way and keeps it through a re-grade', async () => {
    const before = await detail();
    const mc = before.items.find((i) => i.type === 'multiple_choice' && i.answer !== null)!;
    const flipped = !mc.isCorrect;
    const res = await recheck(mc.questionId, flipped);
    const item = res.body.items.find((i: Item) => i.questionId === mc.questionId);
    expect(item.isCorrect).toBe(flipped);
    expect(item.pointsAwarded).toBe(flipped ? mc.points : 0);
    expect(item.autoCorrect).toBe(mc.isCorrect);
    expect(res.body.score).toBe(before.score + (flipped ? mc.points : -mc.points));

    // Re-saving the quiz re-grades every submitted attempt; the teacher's decision must survive.
    const quiz = (await request(app).get(`/api/teacher/quizzes/${quizId}`).set(auth(teacherToken))).body;
    const { id: _id, subject: _s, totalPoints: _t, createdAt: _c, attemptCount: _a, structureLocked: _l, ...payload } = quiz;
    expect((await request(app).put(`/api/teacher/quizzes/${quizId}`).set(auth(teacherToken)).send(payload)).status).toBe(200);
    expect((await detail()).items.find((i) => i.questionId === mc.questionId)!.isCorrect).toBe(flipped);

    // The student's result reflects it.
    const tBen = await studentToken('23-00002');
    const result = await request(app).get(`/api/attempts/${attemptId}/result`).set(auth(tBen));
    expect(result.body.score).toBe(res.body.score);
  });

  it('only teachers can re-check, and only submitted attempts', async () => {
    const tBen = await studentToken('23-00002');
    const q = (await detail()).items[0].questionId;
    expect((await request(app).put(`/api/teacher/attempts/${attemptId}/items/${q}`).set(auth(tBen)).send({ correct: true })).status).toBe(403);
    expect((await recheck(q, 'yes' as unknown as boolean)).status).toBe(400);
    expect((await recheck(999999, true)).status).toBe(400);

    const dina = await prisma.user.findUniqueOrThrow({ where: { srCode: '23-00004' } });
    const open = await prisma.attempt.create({
      data: { assignmentId: assignmentA, studentId: dina.id, questionOrder: [q], choiceOrder: {}, status: 'in_progress' },
    });
    const res = await request(app).put(`/api/teacher/attempts/${open.id}/items/${q}`).set(auth(teacherToken)).send({ correct: true });
    expect(res.status).toBe(409);
    await prisma.attempt.delete({ where: { id: open.id } });
  });
});

describe('irregular students and the Excel template', () => {
  it('downloads an Excel template with one section column per subject', async () => {
    const res = await request(app)
      .get('/api/teacher/students/template')
      .set(auth(teacherToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('Students')!;
    expect((ws.getRow(1).values as string[]).filter(Boolean)).toEqual(['SR code', 'Name', 'Password', 'Database Design', 'Embedded Systems (CpET343)']);
    expect(ws.getCell('D2').dataValidation.type).toBe('list');
    expect(wb.getWorksheet('Instructions')).toBeTruthy();
  });

  it('imports the filled template, including an irregular student with one account in two sections', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Students');
    ws.addRow(['SR code', 'Name', 'Password', 'Database Design', 'Embedded Systems (CpET343)']);
    ws.addRow(['24-30001', 'Regular B', 'pass1234', 'BCpET3102', 'BCpET3102']);
    ws.addRow(['24-30002', 'Irregular', 'pass1234', 'BCpET3102', 'BCpET3101']);
    ws.addRow(['24-30003', 'Embedded only', 'pass1234', '', '3103']);
    const xlsxBase64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

    const bad = new ExcelJS.Workbook();
    const bws = bad.addWorksheet('Students');
    bws.addRow(['SR code', 'Name', 'Password', 'Database Design', 'Embedded Systems (CpET343)']);
    bws.addRow(['24-30009', 'No subjects', 'pass1234', '', '']);
    bws.addRow(['24-30010', 'Bad section', 'pass1234', 'BCpET9999', '']);
    const badRes = await request(app)
      .post('/api/teacher/students/import')
      .set(auth(teacherToken))
      .send({ xlsxBase64: Buffer.from(await bad.xlsx.writeBuffer()).toString('base64') });
    expect(badRes.status).toBe(400);
    expect(badRes.body.details.map((d: { line: number }) => d.line)).toEqual([2, 3]);

    const res = await request(app).post('/api/teacher/students/import').set(auth(teacherToken)).send({ xlsxBase64 });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(3);

    const irregular = await prisma.user.findUniqueOrThrow({
      where: { srCode: '24-30002' },
      include: { section: true, enrollments: { include: { section: true, subject: true }, orderBy: { subjectId: 'asc' } } },
    });
    expect(irregular.section!.name).toBe('BCpET3102'); // own section = first section in the row
    expect(irregular.enrollments.map((e) => `${e.subject.name}@${e.section.name}`)).toEqual([
      'Database Design@BCpET3102',
      'Embedded Systems (CpET343)@BCpET3101',
    ]);
    const only = await prisma.user.findUniqueOrThrow({ where: { srCode: '24-30003' }, include: { section: true, enrollments: true } });
    expect(only.section!.name).toBe('BCpET3103');
    expect(only.enrollments.map((e) => e.subjectId)).toEqual([embeddedId]);
  });

  it('an irregular student sees each subject quiz from the section they take it in', async () => {
    // Embedded Systems quiz assigned to BCpET3101 only; Database Design quiz assigned to BCpET3102 only.
    const es = await request(app)
      .post('/api/teacher/quizzes/import')
      .set(auth(teacherToken))
      .send({ data: { subject: 'Embedded Systems (CpET343)', title: 'ES irregular test', questions: [{ type: 'identification', text: 'ISR?', acceptedAnswers: ['interrupt service routine'] }] } });
    const db = await request(app)
      .post('/api/teacher/quizzes/import')
      .set(auth(teacherToken))
      .send({ data: { subject: 'Database Design', title: 'DB irregular test', questions: [{ type: 'identification', text: 'PK?', acceptedAnswers: ['primary key'] }] } });
    const window = { startAt: await dbIso(-5), dueAt: await dbIso(60) };
    const esA = await request(app)
      .put(`/api/teacher/quizzes/${es.body.created[0].id}/assignments`)
      .set(auth(teacherToken))
      .send({ items: [{ sectionId: sectionA, ...window }] });
    await request(app)
      .put(`/api/teacher/quizzes/${db.body.created[0].id}/assignments`)
      .set(auth(teacherToken))
      .send({ items: [{ sectionId: sectionB, ...window }] });

    const titles = async (sr: string) =>
      (await request(app).get('/api/student/assignments').set(auth(await studentToken24(sr)))).body.items
        .map((i: { title: string }) => i.title)
        .filter((t: string) => t.includes('irregular test'))
        .sort();

    expect(await titles('24-30002')).toEqual(['DB irregular test', 'ES irregular test']); // irregular: both, one account
    expect(await titles('24-30001')).toEqual(['DB irregular test']); // regular BCpET3102: the ES quiz is for BCpET3101

    const tIrregular = await studentToken24('24-30002');
    const esAssignment = esA.body.sections.find((s: { sectionId: number }) => s.sectionId === sectionA).assignment.id;
    expect((await request(app).post('/api/attempts/start').set(auth(tIrregular)).send({ assignmentId: esAssignment })).status).toBe(201);
    expect(
      (await request(app).post('/api/attempts/start').set(auth(await studentToken24('24-30001'))).send({ assignmentId: esAssignment })).status,
    ).toBe(404);

    // The teacher sees the irregular student in the BCpET3101 results for the ES quiz.
    const r = await request(app).get(`/api/teacher/results?quizId=${es.body.created[0].id}`).set(auth(teacherToken));
    const row = r.body.find((x: { srCode: string }) => x.srCode === '24-30002');
    expect(row.section).toBe('BCpET3101');
    expect(row.status).toBe('in_progress');
  });
});

async function studentToken24(srCode: string) {
  const res = await request(app).post('/api/auth/login').send({ srCode, password: 'pass1234' });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

describe('exam security (anti-cheating events)', () => {
  let secureQuizId: number;
  let assignmentId: number;
  let attemptId: number;
  let tokenCora: string;
  const send = (token: string, events: { type: string; durationMs?: number; detail?: string; id?: string }[], id = attemptId) =>
    request(app).post(`/api/attempts/${id}/events`).set(auth(token)).send({ events });

  beforeAll(async () => {
    const imp = await request(app)
      .post('/api/teacher/quizzes/import')
      .set(auth(teacherToken))
      .send({
        data: {
          subject: 'Database Design',
          title: 'Secure exam test',
          secureMode: true,
          maxViolations: 2,
          questions: [{ type: 'identification', text: 'Keyword to add rows?', acceptedAnswers: ['INSERT'] }],
        },
      });
    expect(imp.status).toBe(201);
    secureQuizId = imp.body.created[0].id;
    const asg = await request(app)
      .put(`/api/teacher/quizzes/${secureQuizId}/assignments`)
      .set(auth(teacherToken))
      .send({ items: [{ sectionId: sectionB, startAt: await dbIso(-5), dueAt: await dbIso(60) }] });
    assignmentId = asg.body.sections.find((s: { sectionId: number }) => s.sectionId === sectionB).assignment.id;
    tokenCora = await studentToken('23-00003');
    const start = await request(app).post('/api/attempts/start').set(auth(tokenCora)).send({ assignmentId });
    expect(start.status).toBe(201);
    attemptId = start.body.id;
    expect(start.body.security).toEqual({ enabled: true, maxViolations: 2, violations: 0 });
  });

  it('records blocked copy/paste without counting it, and counts leaving the page', async () => {
    const r1 = await send(tokenCora, [{ type: 'copy_attempt' }, { type: 'paste_attempt' }, { type: 'right_click' }]);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ status: 'in_progress', violations: 0, autoSubmitted: false });

    const r2 = await send(tokenCora, [{ type: 'left_page', detail: 'switched tab', id: 'evt-left-0001' }]);
    expect(r2.body).toMatchObject({ status: 'in_progress', violations: 1, maxViolations: 2 });
    // The same event sent again (reconnect / page-close beacon) is stored once.
    expect((await send(tokenCora, [{ type: 'left_page', detail: 'switched tab', id: 'evt-left-0001' }])).body.violations).toBe(1);
    expect((await send(tokenCora, [{ type: 'returned', durationMs: 4200 }])).body.violations).toBe(1);
  });

  it('rejects unknown event types and other students', async () => {
    expect((await send(tokenCora, [{ type: 'hacked' }])).status).toBe(400);
    expect((await send(await studentToken('23-00001'), [{ type: 'left_page' }])).status).toBe(404);
    expect((await request(app).post(`/api/attempts/${attemptId}/events`).set(auth(tokenCora)).send({ events: [] })).status).toBe(400);
  });

  it('submits automatically when the limit is reached; later events are ignored', async () => {
    const r = await send(tokenCora, [{ type: 'screenshot_key', detail: 'PrintScreen' }]);
    expect(r.body).toMatchObject({ status: 'submitted', autoSubmitted: true, violations: 2 });
    const row = await prisma.attempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(row.status).toBe('submitted');

    const late = await send(tokenCora, [{ type: 'left_page' }]);
    expect(late.status).toBe(200);
    expect(late.body.status).toBe('submitted');
    expect(await prisma.attemptEvent.count({ where: { attemptId } })).toBe(6);

    const result = await request(app).get(`/api/attempts/${attemptId}/result`).set(auth(tokenCora));
    expect(result.body.security).toMatchObject({ autoSubmitted: true, violations: 2, maxViolations: 2 });
  });

  it('shows the teacher the flags and a timed activity log', async () => {
    const rows = (await request(app).get(`/api/teacher/results?quizId=${secureQuizId}`).set(auth(teacherToken))).body;
    const cora = rows.find((x: { srCode: string }) => x.srCode === '23-00003');
    expect(cora).toMatchObject({ flags: 6, violations: 2, status: 'submitted' });

    const d = (await request(app).get(`/api/teacher/attempts/${attemptId}`).set(auth(teacherToken))).body;
    expect(d.security).toMatchObject({ enabled: true, violations: 2, autoSubmitted: true });
    expect(d.events.map((e: { type: string }) => e.type)).toEqual([
      'copy_attempt', 'paste_attempt', 'right_click', 'left_page', 'returned', 'screenshot_key',
    ]);
    expect(d.events.find((e: { type: string }) => e.type === 'returned').durationMs).toBe(4200);

    const csv = await request(app).get(`/api/teacher/results/export?format=csv&quizId=${secureQuizId}`).set(auth(teacherToken));
    expect(csv.text).toContain('Times Left Exam,Security Flags');
  });

  it('stores nothing when exam security is off for the quiz', async () => {
    await prisma.quiz.update({ where: { id: secureQuizId }, data: { secureMode: false } });
    const tBen = await studentToken('23-00002');
    // Ben is in BCpET3101; give the quiz to that section too.
    const asg = await request(app)
      .put(`/api/teacher/quizzes/${secureQuizId}/assignments`)
      .set(auth(teacherToken))
      .send({ items: [{ sectionId: sectionA, startAt: await dbIso(-5), dueAt: await dbIso(60) }] });
    const aId = asg.body.sections.find((s: { sectionId: number }) => s.sectionId === sectionA).assignment.id;
    const start = await request(app).post('/api/attempts/start').set(auth(tBen)).send({ assignmentId: aId });
    expect(start.body.security.enabled).toBe(false);
    const r = await send(tBen, [{ type: 'left_page' }], start.body.id);
    expect(r.body).toMatchObject({ status: 'in_progress', autoSubmitted: false });
    expect(await prisma.attemptEvent.count({ where: { attemptId: start.body.id } })).toBe(0);
  });
});

describe('reopen a submitted attempt for revision', () => {
  it('keeps answers, gives new time, restarts the leave counter and re-grades on the next submit', async () => {
    const imp = await request(app)
      .post('/api/teacher/quizzes/import')
      .set(auth(teacherToken))
      .send({
        data: {
          subject: 'Database Design',
          title: 'Reopen test',
          timeLimitMinutes: 30,
          secureMode: true,
          maxViolations: 2,
          questions: [{ type: 'identification', text: 'Keyword to add rows?', acceptedAnswers: ['INSERT'] }],
        },
      });
    const quizId = imp.body.created[0].id;
    const asg = await request(app)
      .put(`/api/teacher/quizzes/${quizId}/assignments`)
      .set(auth(teacherToken))
      .send({ items: [{ sectionId: sectionB, startAt: await dbIso(-5), dueAt: await dbIso(60) }] });
    const assignmentId = asg.body.sections.find((s: { sectionId: number }) => s.sectionId === sectionB).assignment.id;
    const tCora = await studentToken('23-00003');
    const start = await request(app).post('/api/attempts/start').set(auth(tCora)).send({ assignmentId });
    const id = start.body.id;
    const qid = start.body.questions[0].id;
    const ev = (events: { type: string }[], token = tCora) => request(app).post(`/api/attempts/${id}/events`).set(auth(token)).send({ events });

    await request(app).post(`/api/attempts/${id}/save`).set(auth(tCora)).send({ answers: [{ questionId: qid, answer: 'DELETE' }] }).expect(200);
    await ev([{ type: 'left_page' }]);
    await new Promise((r) => setTimeout(r, 20));
    const auto = await ev([{ type: 'screenshot_key' }]);
    expect(auto.body).toMatchObject({ status: 'submitted', autoSubmitted: true });

    // Reopen is refused for students and for in-progress attempts; students cannot fake a "reopened" event.
    expect((await request(app).post(`/api/teacher/attempts/${id}/reopen`).set(auth(tCora)).send({ minutes: 10 })).status).toBe(403);
    expect((await ev([{ type: 'reopened' }])).status).toBe(400);

    // Teacher gives consideration first (so we can check it is dropped when the answer changes).
    await request(app).put(`/api/teacher/attempts/${id}/items/${qid}`).set(auth(teacherToken)).send({ correct: true }).expect(200);

    const reopened = await request(app).post(`/api/teacher/attempts/${id}/reopen`).set(auth(teacherToken)).send({ minutes: 10 });
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe('in_progress');
    expect(reopened.body.events.map((e: { type: string }) => e.type)).toContain('reopened');
    expect((await request(app).post(`/api/teacher/attempts/${id}/reopen`).set(auth(teacherToken)).send({ minutes: 10 })).status).toBe(409);

    const view = await request(app).get(`/api/attempts/${id}`).set(auth(tCora));
    expect(view.body.status).toBe('in_progress');
    expect(view.body.answers[String(qid)]).toBe('DELETE');
    expect(view.body.security.violations).toBe(0); // counter restarted
    const left = new Date(view.body.deadline).getTime() - new Date(view.body.serverNow).getTime();
    expect(left).toBeGreaterThan(9 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000);

    // One more leave is under the limit of 2 now.
    expect((await ev([{ type: 'left_page' }])).body).toMatchObject({ status: 'in_progress', violations: 1 });

    // Changing the answer drops the teacher's earlier decision on it.
    await request(app).post(`/api/attempts/${id}/save`).set(auth(tCora)).send({ answers: [{ questionId: qid, answer: 'insert' }] }).expect(200);
    const row = await prisma.attemptAnswer.findUniqueOrThrow({ where: { attemptId_questionId: { attemptId: id, questionId: qid } } });
    expect(row.overrideCorrect).toBeNull();

    const res = await request(app).post(`/api/attempts/${id}/submit`).set(auth(tCora));
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(1);

    // The teacher still sees every event, before and after the reopen.
    const d = (await request(app).get(`/api/teacher/attempts/${id}`).set(auth(teacherToken))).body;
    expect(d.events.filter((e: { type: string }) => e.type === 'left_page')).toHaveLength(2);
    expect(d.reopenedAt).toBeTruthy();
  });
});

describe('opening the exam page again counts as leaving it', () => {
  let attemptId: number;
  let tCora: string;
  const ev = (events: { type: string; id: string }[]) =>
    request(app).post(`/api/attempts/${attemptId}/events`).set(auth(tCora)).send({ events });

  beforeAll(async () => {
    const imp = await request(app)
      .post('/api/teacher/quizzes/import')
      .set(auth(teacherToken))
      .send({
        data: {
          subject: 'Database Design',
          title: 'Reload test',
          secureMode: true,
          maxViolations: 2,
          questions: [{ type: 'identification', text: 'Keyword to add rows?', acceptedAnswers: ['INSERT'] }],
        },
      });
    const asg = await request(app)
      .put(`/api/teacher/quizzes/${imp.body.created[0].id}/assignments`)
      .set(auth(teacherToken))
      .send({ items: [{ sectionId: sectionB, startAt: await dbIso(-5), dueAt: await dbIso(60) }] });
    const assignmentId = asg.body.sections.find((s: { sectionId: number }) => s.sectionId === sectionB).assignment.id;
    tCora = await studentToken('23-00003');
    const start = await request(app).post('/api/attempts/start').set(auth(tCora)).send({ assignmentId });
    expect(start.status).toBe(201);
    attemptId = start.body.id;
  });

  it('the first open is free; every later open (reload, closed tab, another device) counts once', async () => {
    expect((await ev([{ type: 'page_opened', id: 'open-0001' }])).body).toMatchObject({ status: 'in_progress', violations: 0 });

    const reload = await ev([{ type: 'page_closed', id: 'close-0001' }, { type: 'page_opened', id: 'open-0002' }]);
    expect(reload.body).toMatchObject({ status: 'in_progress', violations: 1 });
    // The same open sent again (retry after a reconnect) is not counted twice.
    expect((await ev([{ type: 'page_opened', id: 'open-0002' }])).body.violations).toBe(1);

    const d = (await request(app).get(`/api/teacher/attempts/${attemptId}`).set(auth(teacherToken))).body;
    expect(d.events.filter((e: { counted: boolean }) => e.counted).map((e: { type: string }) => e.type)).toEqual(['left_page']);

    expect((await ev([{ type: 'page_opened', id: 'open-0003' }])).body).toMatchObject({ status: 'submitted', autoSubmitted: true, violations: 2 });
  });

  it('after the teacher reopens the attempt, the first open is free again', async () => {
    expect((await request(app).post(`/api/teacher/attempts/${attemptId}/reopen`).set(auth(teacherToken)).send({ minutes: 10 })).status).toBe(200);
    expect((await ev([{ type: 'page_opened', id: 'open-0004' }])).body).toMatchObject({ status: 'in_progress', violations: 0 });
    expect((await ev([{ type: 'page_opened', id: 'open-0005' }])).body).toMatchObject({ status: 'in_progress', violations: 1 });
  });
});

describe('a random pick of items per student', () => {
  const SR = ['23-30001', '23-30002', '23-30003', '23-30004'];
  const tokens: string[] = [];
  type Q = { id: number; text: string };

  /** Ten 1-point identification questions; "Pool question N" is answered "AN". */
  const poolQuiz = (title: string, extra: Record<string, unknown>) => ({
    subject: 'Database Design',
    title,
    timeLimitMinutes: 30,
    secureMode: false,
    ...extra,
    questions: Array.from({ length: 10 }, (_, i) => ({ type: 'identification', text: `Pool question ${i + 1}`, acceptedAnswers: [`A${i + 1}`] })),
  });
  const importQuiz = (data: unknown) => request(app).post('/api/teacher/quizzes/import').set(auth(teacherToken)).send({ data });
  const editPayload = async (id: number) => {
    const quiz = (await request(app).get(`/api/teacher/quizzes/${id}`).set(auth(teacherToken))).body;
    const { id: _id, subject: _s, totalPoints: _t, createdAt: _c, attemptCount: _a, structureLocked: _l, ...payload } = quiz;
    return payload;
  };
  async function assignToA(quizId: number): Promise<number> {
    const asg = await request(app)
      .put(`/api/teacher/quizzes/${quizId}/assignments`)
      .set(auth(teacherToken))
      .send({ items: [{ sectionId: sectionA, startAt: await dbIso(-5), dueAt: await dbIso(60) }] });
    return asg.body.sections.find((s: { sectionId: number }) => s.sectionId === sectionA).assignment.id;
  }
  const start = (token: string, assignmentId: number) => request(app).post('/api/attempts/start').set(auth(token)).send({ assignmentId });

  let quizId: number;
  let assignmentId: number;
  const attempts: { id: number; questions: Q[] }[] = [];

  beforeAll(async () => {
    const hash = await hashPassword(PW);
    for (const [i, srCode] of SR.entries()) {
      const s = await prisma.user.create({ data: { role: 'student', srCode, name: `Pool ${i + 1}`, sectionId: sectionA, passwordHash: hash } });
      await prisma.studentSubject.create({ data: { studentId: s.id, subjectId, sectionId: sectionA } });
      tokens.push(await studentToken(srCode));
    }
    const imp = await importQuiz(poolQuiz('Pool quiz', { itemsPerStudent: 3 }));
    expect(imp.status).toBe(201);
    quizId = imp.body.created[0].id;
    assignmentId = await assignToA(quizId);
  });

  it('gives each student their own random pick of the set number of items, kept on resume', async () => {
    const dash = await request(app).get('/api/student/assignments').set(auth(tokens[0]));
    expect(dash.body.items.find((x: { quizId: number }) => x.quizId === quizId)).toMatchObject({ questionCount: 3, totalPoints: 3 });

    const all = new Set((await prisma.question.findMany({ where: { quizId } })).map((q) => q.id));
    for (const token of tokens) {
      const r = await start(token, assignmentId);
      expect(r.status).toBe(201);
      const ids = r.body.questions.map((q: Q) => q.id);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      expect(ids.every((id: number) => all.has(id))).toBe(true);
      expect(r.body.quiz.totalPoints).toBe(3);
      attempts.push({ id: r.body.id, questions: r.body.questions });

      const again = await request(app).get(`/api/attempts/${r.body.id}`).set(auth(token));
      expect(again.body.questions.map((q: Q) => q.id)).toEqual(ids);
    }
    // 120 possible sets of 3 out of 10: four students drawing the same one means there is no random pick.
    expect(new Set(attempts.map((a) => a.questions.map((q) => q.id).sort().join())).size).toBeGreaterThan(1);
  });

  it('scores each student out of the items they were given', async () => {
    const [a] = attempts;
    const answers = a.questions.map((q) => ({ questionId: q.id, answer: `A${q.text.split(' ').pop()}` }));
    await request(app).post(`/api/attempts/${a.id}/save`).set(auth(tokens[0])).send({ answers }).expect(200);
    const res = await request(app).post(`/api/attempts/${a.id}/submit`).set(auth(tokens[0]));
    expect(res.body).toMatchObject({ score: 3, totalPoints: 3 });

    const rows = (await request(app).get(`/api/teacher/results?quizId=${quizId}`).set(auth(teacherToken))).body;
    expect(rows.find((r: { srCode: string }) => r.srCode === SR[0])).toMatchObject({ score: 3, totalPoints: 3 });
    const d = (await request(app).get(`/api/teacher/attempts/${a.id}`).set(auth(teacherToken))).body;
    expect(d).toMatchObject({ score: 3, totalPoints: 3 });
    expect(d.items).toHaveLength(3);

    // The dashboard average agrees with the results table (a full score counts as 100%, not 30%).
    const section = (await request(app).get(`/api/teacher/results?sectionId=${sectionA}&subjectId=${subjectId}`).set(auth(teacherToken))).body;
    const pcts = section
      .filter((r: { status: string }) => r.status === 'submitted')
      .map((r: { score: number; totalPoints: number }) => (r.score * 100) / r.totalPoints);
    const expected = Math.round((pcts.reduce((s: number, p: number) => s + p, 0) / pcts.length) * 10) / 10;
    const dash = (await request(app).get('/api/teacher/dashboard').set(auth(teacherToken))).body;
    expect(dash.stats.find((s: { sectionId: number; subjectId: number }) => s.sectionId === sectionA && s.subjectId === subjectId).averagePercent).toBe(expected);
  });

  it('without shuffling, the picked items keep the quiz order', async () => {
    const imp = await importQuiz(poolQuiz('Pool quiz in order', { itemsPerStudent: 5, shuffleQuestions: false }));
    const r = await start(tokens[1], await assignToA(imp.body.created[0].id));
    const numbers = r.body.questions.map((q: Q) => Number(q.text.split(' ').pop()));
    expect(numbers).toHaveLength(5);
    expect(numbers).toEqual([...numbers].sort((x: number, y: number) => x - y));
  });

  it('rejects more items than questions, and locks the number once a student has started', async () => {
    expect((await importQuiz(poolQuiz('Too many', { itemsPerStudent: 11 }))).status).toBe(400);

    const fresh = (await importQuiz(poolQuiz('Not started yet', {}))).body.created[0].id;
    const put = (id: number, body: object) => request(app).put(`/api/teacher/quizzes/${id}`).set(auth(teacherToken)).send(body);
    expect((await put(fresh, { ...(await editPayload(fresh)), itemsPerStudent: 11 })).status).toBe(400);
    expect((await put(fresh, { ...(await editPayload(fresh)), itemsPerStudent: 4 })).status).toBe(200);

    const started = await editPayload(quizId);
    expect(started.itemsPerStudent).toBe(3);
    const changed = await put(quizId, { ...started, itemsPerStudent: 4 });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('QUIZ_LOCKED');
    expect((await put(quizId, started)).status).toBe(200);
  });
});
