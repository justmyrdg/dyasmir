-- AlterTable
ALTER TABLE "attempts" ADD COLUMN     "extended_until" TIMESTAMPTZ(6),
ADD COLUMN     "reopened_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "quizzes" ALTER COLUMN "max_violations" SET DEFAULT 5;

-- Quizzes still on the old default limit (3) move to the new default (5).
UPDATE "quizzes" SET "max_violations" = 5 WHERE "max_violations" = 3;

-- "reopened" is logged when the teacher reopens an attempt for revision.
ALTER TABLE "attempt_events" DROP CONSTRAINT "attempt_events_type_check";
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_type_check" CHECK ("type" IN (
  'left_page', 'returned', 'screenshot_key', 'fullscreen_exit', 'print_attempt',
  'copy_attempt', 'cut_attempt', 'paste_attempt', 'right_click', 'split_screen', 'page_closed', 'page_opened',
  'reopened'
));
