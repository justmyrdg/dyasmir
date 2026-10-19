/**
 * Writes every quiz in this database, answer keys included, to a JSON file in the import format, so another
 * database can be filled from it (bootstrap loads data/seed/ on every deploy; seed:quizzes loads any file).
 *
 *   npm run export:quizzes                       # -> data/seed/quizzes.json
 *   npm run export:quizzes -- path/to/out.json
 */
import '../src/config';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/db';

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data/seed/quizzes.json';
  const out = path.resolve(process.cwd(), file);

  const quizzes = await prisma.quiz.findMany({
    orderBy: { id: 'asc' },
    include: {
      subject: { select: { name: true } },
      questions: {
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        include: {
          choices: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
          acceptedAnswers: { orderBy: { id: 'asc' } },
        },
      },
    },
  });

  const data = {
    quizzes: quizzes.map((q) => ({
      subject: q.subject.name,
      title: q.title,
      timeLimitMinutes: q.timeLimitMinutes,
      shuffleQuestions: q.shuffleQuestions,
      shuffleChoices: q.shuffleChoices,
      showResultsToStudents: q.showResultsToStudents,
      secureMode: q.secureMode,
      maxViolations: q.maxViolations,
      ...(q.itemsPerStudent != null ? { itemsPerStudent: q.itemsPerStudent } : {}),
      questions: q.questions.map((x) =>
        x.type === 'multiple_choice'
          ? {
              type: x.type,
              text: x.text,
              points: x.points,
              choices: x.choices.map((c) => c.text),
              answer: x.choices.findIndex((c) => c.isCorrect),
            }
          : { type: x.type, text: x.text, points: x.points, acceptedAnswers: x.acceptedAnswers.map((a) => a.answerText) },
      ),
    })),
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  for (const q of quizzes) console.log(`export  "${q.title}" (${q.subject.name}, ${q.questions.length} questions, ${q.totalPoints} points)`);
  console.log(`Wrote ${quizzes.length} quizzes to ${path.relative(process.cwd(), out)}`);
}

main()
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
