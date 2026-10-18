-- AlterTable
ALTER TABLE "attempt_answers" ADD COLUMN     "auto_correct" BOOLEAN,
ADD COLUMN     "overridden_at" TIMESTAMPTZ(6),
ADD COLUMN     "override_correct" BOOLEAN;

-- Existing graded answers: the stored result came from the auto-check.
UPDATE "attempt_answers" SET "auto_correct" = "is_correct" WHERE "is_correct" IS NOT NULL;

-- A teacher decision always records when it was made.
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_override_has_time"
  CHECK (("override_correct" IS NULL) = ("overridden_at" IS NULL));
