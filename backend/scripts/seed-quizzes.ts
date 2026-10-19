/**
 * Loads quizzes from a JSON file (format: data/quizzes.sample.json).
 *
 *   npm run seed:quizzes -- data/quizzes.json            # skip quizzes whose title already exists in that subject
 *   npm run seed:quizzes -- data/quizzes.json --replace  # replace same-titled quizzes that nobody has been assigned yet
 *   npm run seed:quizzes -- data/quizzes.json --strict   # require each quiz to be 30 points: 20 multiple choice + 10 identification
 */
import '../src/config';
import path from 'node:path';
import { prisma } from '../src/db';
import { seedQuizFile } from './lib/seed';

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const replace = process.argv.includes('--replace');
  const strict = process.argv.includes('--strict');
  if (!file) throw new Error('Usage: npm run seed:quizzes -- <path/to/quizzes.json> [--replace] [--strict]');

  await seedQuizFile(path.resolve(process.cwd(), file), { replace, strict });
}

main()
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
