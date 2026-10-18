-- AlterTable
ALTER TABLE "quizzes" ADD COLUMN     "max_violations" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "secure_mode" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "attempt_events" (
    "id" SERIAL NOT NULL,
    "attempt_id" INTEGER NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client_time" TIMESTAMPTZ(6),
    "duration_ms" INTEGER,
    "detail" VARCHAR(200),

    CONSTRAINT "attempt_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attempt_events_attempt_id_occurred_at_idx" ON "attempt_events"("attempt_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Known event types; durations and limits are non-negative.
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_type_check" CHECK ("type" IN (
  'left_page', 'returned', 'screenshot_key', 'fullscreen_exit', 'print_attempt',
  'copy_attempt', 'cut_attempt', 'paste_attempt', 'right_click', 'split_screen', 'page_closed', 'page_opened'
));
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_duration_nonneg" CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0);
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_max_violations_range" CHECK ("max_violations" BETWEEN 0 AND 100);
