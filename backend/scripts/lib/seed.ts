/** Shared by the seed-quizzes and bootstrap scripts. */
import fs from 'node:fs';
import { prisma } from '../../src/db';
import { normalizeQuiz, quizList } from '../../src/teacher/quiz-import';
import { createQuiz, subjectLookup } from '../../src/teacher/quizzes.service';

export interface SeedQuizOptions {
  /** Replace same-titled quizzes that nobody has been assigned yet (default: skip them). */
  replace?: boolean;
  /** Require each quiz to be 30 points: 20 multiple choice + 10 identification. */
  strict?: boolean;
}

/** Loads every quiz in a JSON file (format: data/quizzes.sample.json). Quizzes already there are skipped. */
export async function seedQuizFile(fullPath: string, { replace = false, strict = false }: SeedQuizOptions = {}) {
  const data = JSON.parse(fs.readFileSync(fullPath, 'utf8').replace(/^﻿/, ''));
  const subjects = await subjectLookup();
  const list = quizList(data);

  const dtos = [];
  for (const [i, raw] of list.entries()) {
    try {
      dtos.push(await normalizeQuiz(raw, subjects, i));
    } catch (e) {
      const err = e as { message: string; details?: unknown };
      throw new Error(`${err.message}${err.details ? `\n  ${JSON.stringify(err.details, null, 2)}` : ''}`);
    }
  }

  for (const dto of dtos) {
    const mc = dto.questions.filter((q) => q.type === 'multiple_choice').length;
    const id = dto.questions.length - mc;
    const points = dto.questions.reduce((s, q) => s + q.points, 0);
    const summary = `"${dto.title}": ${mc} multiple choice + ${id} identification = ${points} points`;
    if (strict && (mc !== 20 || id !== 10 || points !== 30)) throw new Error(`${summary} (expected 20 + 10 = 30 points)`);

    const existing = await prisma.quiz.findFirst({
      where: { title: dto.title, subjectId: dto.subjectId },
      include: { _count: { select: { assignments: true } } },
    });
    if (existing && !replace) {
      console.log(`skip    ${summary} (already exists, id ${existing.id}; use --replace to overwrite)`);
      continue;
    }
    if (existing && existing._count.assignments > 0) {
      console.log(`skip    ${summary} (already assigned to sections, not replacing)`);
      continue;
    }
    const created = await prisma.$transaction(
      async (tx) => {
        if (existing) await tx.quiz.delete({ where: { id: existing.id } });
        return createQuiz(dto, tx);
      },
      { timeout: 60_000 },
    );
    console.log(`${existing ? 'replace' : 'create '} ${summary} (id ${created.id})`);
  }
}
