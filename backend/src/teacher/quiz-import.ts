/**
 * Turns a quiz JSON file into QuizDto-shaped objects. Accepts a few common spellings so a hand-written
 * file works without fuss. Canonical format (see data/quizzes.sample.json):
 *
 * {
 *   "quizzes": [{
 *     "subject": "Database Design",          // or "subjectId": 1
 *     "title": "Quiz 1",
 *     "timeLimitMinutes": 45,
 *     "shuffleQuestions": true, "shuffleChoices": true, "showResultsToStudents": false,
 *     "itemsPerStudent": 30,                 // optional: each student gets 30 of the questions, picked at random
 *     "questions": [
 *       { "type": "multiple_choice", "text": "...", "points": 1,
 *         "choices": ["A", "B", "C", "D"], "answer": 2 },          // answer = 0-based index or the choice text
 *       { "type": "identification", "text": "...", "points": 1,
 *         "acceptedAnswers": ["primary key", "PK"] }
 *     ]
 *   }]
 * }
 */
import { badRequest } from '../lib/http-error';
import { toDto } from '../lib/validate';
import { QuestionDto, QuizDto } from './teacher.dto';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function pick(o: Json, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

function normalizeType(raw: unknown, q: Json): 'multiple_choice' | 'identification' {
  const t = str(raw).toLowerCase().replace(/[\s-]+/g, '_');
  if (['multiple_choice', 'mc', 'mcq', 'multiplechoice', 'choice'].includes(t)) return 'multiple_choice';
  if (['identification', 'id', 'ident', 'text', 'short_answer', 'fill_in'].includes(t)) return 'identification';
  if (!t) return Array.isArray(q.choices) || Array.isArray(q.options) ? 'multiple_choice' : 'identification';
  throw new Error(`unknown question type "${str(raw)}"`);
}

export function normalizeQuestion(raw: unknown, index: number): QuestionDto {
  const where = `question ${index + 1}`;
  if (!isObj(raw)) throw new Error(`${where}: must be an object`);
  const type = normalizeType(pick(raw, 'type', 'kind'), raw);
  const text = str(pick(raw, 'text', 'question', 'prompt'));
  const pointsRaw = pick(raw, 'points', 'point', 'score');
  const points = pointsRaw === undefined ? 1 : Number(pointsRaw);

  const q = { type, text, points } as QuestionDto;
  if (typeof raw.id === 'number') q.id = raw.id;

  if (type === 'multiple_choice') {
    const list = pick(raw, 'choices', 'options');
    if (!Array.isArray(list)) throw new Error(`${where}: multiple choice needs a "choices" array`);
    const answer = pick(raw, 'answer', 'correct', 'correctAnswer', 'correctIndex', 'key');
    q.choices = list.map((c, i) => {
      if (isObj(c)) {
        const flag = pick(c, 'isCorrect', 'correct', 'is_correct');
        return {
          ...(typeof c.id === 'number' ? { id: c.id } : {}),
          text: str(pick(c, 'text', 'label', 'value')),
          isCorrect: flag === true || (answer !== undefined && matchesAnswer(answer, i, str(pick(c, 'text', 'label', 'value')))),
        };
      }
      return { text: str(c), isCorrect: answer !== undefined && matchesAnswer(answer, i, str(c)) };
    });
    const nCorrect = q.choices.filter((c) => c.isCorrect).length;
    if (nCorrect !== 1) throw new Error(`${where}: exactly one choice must be correct (found ${nCorrect})`);
  } else {
    const list = pick(raw, 'acceptedAnswers', 'accepted_answers', 'answers', 'answer');
    const arr = Array.isArray(list) ? list : list === undefined ? [] : [list];
    q.acceptedAnswers = arr.map(str).filter((s) => s.length > 0);
  }
  return q;
}

function matchesAnswer(answer: unknown, index: number, text: string): boolean {
  if (typeof answer === 'number') return answer === index;
  const a = str(answer);
  if (/^[A-Da-d]$/.test(a)) return a.toUpperCase().charCodeAt(0) - 65 === index; // "B" = second choice
  return a.toLowerCase() === text.toLowerCase();
}

export interface SubjectLookup {
  byName: Map<string, number>;
  ids: Set<number>;
}

export async function normalizeQuiz(raw: unknown, subjects: SubjectLookup, index = 0): Promise<QuizDto> {
  const where = `quiz ${index + 1}`;
  if (!isObj(raw)) throw badRequest(`${where}: must be an object`);

  let subjectId: number | undefined;
  const sid = pick(raw, 'subjectId', 'subject_id');
  if (typeof sid === 'number' && subjects.ids.has(sid)) subjectId = sid;
  const sname = str(pick(raw, 'subject', 'subjectName'));
  if (!subjectId && sname) subjectId = subjects.byName.get(sname.toLowerCase());
  if (!subjectId) throw badRequest(`${where}: unknown subject "${sname || sid}"`);

  const questionsRaw = pick(raw, 'questions', 'items');
  if (!Array.isArray(questionsRaw)) throw badRequest(`${where}: "questions" must be an array`);

  let questions: QuestionDto[];
  try {
    questions = questionsRaw.map((q, i) => normalizeQuestion(q, i));
  } catch (e) {
    throw badRequest(`${where}: ${(e as Error).message}`);
  }

  const plain = {
    subjectId,
    title: str(pick(raw, 'title', 'name')),
    timeLimitMinutes: Number(pick(raw, 'timeLimitMinutes', 'time_limit_minutes', 'timeLimit') ?? 60),
    shuffleQuestions: bool(pick(raw, 'shuffleQuestions', 'shuffle_questions'), true),
    shuffleChoices: bool(pick(raw, 'shuffleChoices', 'shuffle_choices'), true),
    showResultsToStudents: bool(pick(raw, 'showResultsToStudents', 'show_results_to_students'), false),
    secureMode: bool(pick(raw, 'secureMode', 'secure_mode'), true),
    maxViolations: Number(pick(raw, 'maxViolations', 'max_violations') ?? 5),
    itemsPerStudent: optionalNumber(pick(raw, 'itemsPerStudent', 'items_per_student')),
    questions,
  };
  try {
    return await toDto(QuizDto, plain);
  } catch (e) {
    const err = e as { message: string; details?: unknown };
    throw badRequest(`${where}: ${err.message}`, err.details);
  }
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Missing, null or "" = not set; anything else must pass the DTO's number checks. */
function optionalNumber(v: unknown): number | null {
  return v === undefined || v === null || v === '' ? null : Number(v);
}

/** Accepts { quizzes: [...] }, a bare array of quizzes, or a single quiz object. */
export function quizList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (isObj(data) && Array.isArray(data.quizzes)) return data.quizzes;
  if (isObj(data)) return [data];
  throw badRequest('JSON must be a quiz, an array of quizzes, or { "quizzes": [...] }');
}

/** Accepts { questions: [...] } or a bare array of questions (for importing into the editor). */
export async function normalizeQuestionList(data: unknown): Promise<QuestionDto[]> {
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.questions) ? data.questions : null;
  if (!list) throw badRequest('JSON must be an array of questions or { "questions": [...] }');
  const out: QuestionDto[] = [];
  for (let i = 0; i < list.length; i++) {
    try {
      const q = normalizeQuestion(list[i], i);
      delete q.id;
      out.push(await toDto(QuestionDto, q));
    } catch (e) {
      const err = e as { message: string; details?: unknown };
      throw badRequest(`question ${i + 1}: ${err.message}`, err.details);
    }
  }
  return out;
}
