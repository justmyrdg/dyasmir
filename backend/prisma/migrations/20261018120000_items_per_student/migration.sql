-- AlterTable
ALTER TABLE "quizzes" ADD COLUMN     "items_per_student" INTEGER;

-- Null = every student gets every question. Not more than the quiz has is checked by the API
-- (a CHECK constraint cannot count rows of another table).
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_items_per_student_positive" CHECK ("items_per_student" IS NULL OR "items_per_student" > 0);
