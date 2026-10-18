/**
 * Reference data: sections BCpET3101-3103; the two subjects; every section offers both subjects.
 * Idempotent (the migrations insert the same rows; this is safe to run any time).
 * Which subjects each student actually takes is stored per student (student_subjects).
 *
 *   npx prisma db seed
 */
import { PrismaClient } from '@prisma/client';

const SECTIONS = ['BCpET3101', 'BCpET3102', 'BCpET3103'];
const SUBJECTS = ['Database Design', 'Embedded Systems (CpET343)'];

const prisma = new PrismaClient();

async function main() {
  const sections = await Promise.all(
    SECTIONS.map((name) => prisma.section.upsert({ where: { name }, create: { name }, update: {} })),
  );
  const subjects = await Promise.all(
    SUBJECTS.map((name) => prisma.subject.upsert({ where: { name }, create: { name }, update: {} })),
  );
  await prisma.sectionSubject.createMany({
    data: sections.flatMap((s) => subjects.map((j) => ({ sectionId: s.id, subjectId: j.id }))),
    skipDuplicates: true,
  });
  console.log(`Seeded sections ${SECTIONS.join(', ')} and subjects: ${SUBJECTS.join('; ')}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
