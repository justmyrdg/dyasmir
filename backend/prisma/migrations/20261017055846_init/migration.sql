-- CreateTable
CREATE TABLE "sections" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(10) NOT NULL,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_subjects" (
    "section_id" INTEGER NOT NULL,
    "subject_id" INTEGER NOT NULL,

    CONSTRAINT "section_subjects_pkey" PRIMARY KEY ("section_id","subject_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "sr_code" VARCHAR(8),
    "email" VARCHAR(255),
    "name" VARCHAR(150) NOT NULL,
    "role" VARCHAR(10) NOT NULL,
    "section_id" INTEGER,
    "password_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quizzes" (
    "id" SERIAL NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "time_limit_minutes" INTEGER NOT NULL,
    "shuffle_questions" BOOLEAN NOT NULL DEFAULT true,
    "shuffle_choices" BOOLEAN NOT NULL DEFAULT true,
    "show_results_to_students" BOOLEAN NOT NULL DEFAULT false,
    "total_points" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quizzes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" SERIAL NOT NULL,
    "quiz_id" INTEGER NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "text" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 1,
    "position" INTEGER NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "choices" (
    "id" SERIAL NOT NULL,
    "question_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "choices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accepted_answers" (
    "id" SERIAL NOT NULL,
    "question_id" INTEGER NOT NULL,
    "answer_text" TEXT NOT NULL,

    CONSTRAINT "accepted_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" SERIAL NOT NULL,
    "quiz_id" INTEGER NOT NULL,
    "section_id" INTEGER NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempts" (
    "id" SERIAL NOT NULL,
    "assignment_id" INTEGER NOT NULL,
    "student_id" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "question_order" JSONB NOT NULL,
    "choice_order" JSONB NOT NULL,
    "current_index" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(12) NOT NULL DEFAULT 'in_progress',
    "submitted_at" TIMESTAMPTZ(6),
    "score" INTEGER,

    CONSTRAINT "attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_answers" (
    "attempt_id" INTEGER NOT NULL,
    "question_id" INTEGER NOT NULL,
    "answer" TEXT NOT NULL,
    "is_correct" BOOLEAN,
    "points_awarded" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attempt_answers_pkey" PRIMARY KEY ("attempt_id","question_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sections_name_key" ON "sections"("name");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_name_key" ON "subjects"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_sr_code_key" ON "users"("sr_code");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_section_id_idx" ON "users"("section_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "quizzes_subject_id_idx" ON "quizzes"("subject_id");

-- CreateIndex
CREATE INDEX "questions_quiz_id_idx" ON "questions"("quiz_id");

-- CreateIndex
CREATE INDEX "choices_question_id_idx" ON "choices"("question_id");

-- CreateIndex
CREATE INDEX "accepted_answers_question_id_idx" ON "accepted_answers"("question_id");

-- CreateIndex
CREATE INDEX "assignments_section_id_idx" ON "assignments"("section_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_quiz_id_section_id_key" ON "assignments"("quiz_id", "section_id");

-- CreateIndex
CREATE INDEX "attempts_student_id_idx" ON "attempts"("student_id");

-- CreateIndex
CREATE INDEX "attempts_status_idx" ON "attempts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "attempts_assignment_id_student_id_key" ON "attempts"("assignment_id", "student_id");

-- AddForeignKey
ALTER TABLE "section_subjects" ADD CONSTRAINT "section_subjects_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_subjects" ADD CONSTRAINT "section_subjects_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "choices" ADD CONSTRAINT "choices_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accepted_answers" ADD CONSTRAINT "accepted_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECK constraints (not expressible in schema.prisma)
-- ---------------------------------------------------------------------------

ALTER TABLE "sections" ADD CONSTRAINT "sections_name_not_blank" CHECK (length(btrim("name")) > 0);
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_name_not_blank" CHECK (length(btrim("name")) > 0);

ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('teacher', 'student'));
ALTER TABLE "users" ADD CONSTRAINT "users_sr_code_format" CHECK ("sr_code" IS NULL OR "sr_code" ~ '^\d{2}-\d{5}$');
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" IS NULL OR "email" = lower("email"));
ALTER TABLE "users" ADD CONSTRAINT "users_name_not_blank" CHECK (length(btrim("name")) > 0);
ALTER TABLE "users" ADD CONSTRAINT "users_failed_login_count_nonneg" CHECK ("failed_login_count" >= 0);
-- Students must have an SR code and a section; the teacher has an email and no section.
ALTER TABLE "users" ADD CONSTRAINT "users_role_fields" CHECK (
  ("role" = 'student' AND "sr_code" IS NOT NULL AND "section_id" IS NOT NULL)
  OR ("role" = 'teacher' AND "email" IS NOT NULL AND "section_id" IS NULL)
);

ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_expiry_after_creation" CHECK ("expires_at" > "created_at");

ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_time_limit_positive" CHECK ("time_limit_minutes" > 0);
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_total_points_nonneg" CHECK ("total_points" >= 0);
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_title_not_blank" CHECK (length(btrim("title")) > 0);

ALTER TABLE "questions" ADD CONSTRAINT "questions_type_check" CHECK ("type" IN ('multiple_choice', 'identification'));
ALTER TABLE "questions" ADD CONSTRAINT "questions_points_positive" CHECK ("points" > 0);
ALTER TABLE "questions" ADD CONSTRAINT "questions_position_nonneg" CHECK ("position" >= 0);
ALTER TABLE "questions" ADD CONSTRAINT "questions_text_not_blank" CHECK (length(btrim("text")) > 0);

ALTER TABLE "choices" ADD CONSTRAINT "choices_position_nonneg" CHECK ("position" >= 0);
ALTER TABLE "choices" ADD CONSTRAINT "choices_text_not_blank" CHECK (length(btrim("text")) > 0);

ALTER TABLE "accepted_answers" ADD CONSTRAINT "accepted_answers_text_not_blank" CHECK (length(btrim("answer_text")) > 0);

ALTER TABLE "assignments" ADD CONSTRAINT "assignments_due_after_start" CHECK ("due_at" > "start_at");

ALTER TABLE "attempts" ADD CONSTRAINT "attempts_status_check" CHECK ("status" IN ('in_progress', 'submitted'));
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_current_index_nonneg" CHECK ("current_index" >= 0);
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_score_nonneg" CHECK ("score" IS NULL OR "score" >= 0);
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_question_order_array" CHECK (jsonb_typeof("question_order") = 'array');
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_choice_order_object" CHECK (jsonb_typeof("choice_order") = 'object');
-- A submitted attempt always has a score and submission time; an in-progress one has neither.
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_submission_consistent" CHECK (
  ("status" = 'in_progress' AND "submitted_at" IS NULL AND "score" IS NULL)
  OR ("status" = 'submitted' AND "submitted_at" IS NOT NULL AND "score" IS NOT NULL)
);

ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_points_nonneg" CHECK ("points_awarded" IS NULL OR "points_awarded" >= 0);

-- ---------------------------------------------------------------------------
-- Multiple-choice questions: exactly 4 choices, exactly one correct.
-- Identification questions: no choices.
-- Deferred to commit so a question and its choices can be written in one transaction.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "check_question_choices"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  qid     INTEGER;
  qtype   TEXT;
  n_total INTEGER;
  n_right INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    qid := OLD.question_id;
  ELSE
    qid := NEW.question_id;
  END IF;

  SELECT "type" INTO qtype FROM "questions" WHERE "id" = qid;
  IF qtype IS NULL THEN
    RETURN NULL; -- question itself was deleted (cascade)
  END IF;

  SELECT count(*), count(*) FILTER (WHERE "is_correct")
    INTO n_total, n_right
    FROM "choices" WHERE "question_id" = qid;

  IF qtype = 'identification' AND n_total > 0 THEN
    RAISE EXCEPTION 'Identification question % cannot have choices', qid USING ERRCODE = 'check_violation';
  END IF;
  IF qtype = 'multiple_choice' AND (n_total <> 4 OR n_right <> 1) THEN
    RAISE EXCEPTION 'Multiple-choice question % must have exactly 4 choices with exactly one correct (has % choices, % correct)',
      qid, n_total, n_right USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "choices_valid_for_question"
  AFTER INSERT OR UPDATE OR DELETE ON "choices"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_question_choices"();

-- Accepted answers belong to identification questions only.
CREATE FUNCTION "check_accepted_answer_question"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT "type" FROM "questions" WHERE "id" = NEW.question_id) <> 'identification' THEN
    RAISE EXCEPTION 'Accepted answers are only allowed on identification questions (question %)', NEW.question_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accepted_answers_identification_only"
  BEFORE INSERT OR UPDATE ON "accepted_answers"
  FOR EACH ROW EXECUTE FUNCTION "check_accepted_answer_question"();

-- ---------------------------------------------------------------------------
-- Reference data: sections A, B, C; both subjects; every section takes both.
-- ---------------------------------------------------------------------------

INSERT INTO "sections" ("name") VALUES ('A'), ('B'), ('C') ON CONFLICT DO NOTHING;
INSERT INTO "subjects" ("name") VALUES ('Database Design'), ('Embedded Systems (CpET343)') ON CONFLICT DO NOTHING;
INSERT INTO "section_subjects" ("section_id", "subject_id")
  SELECT s.id, j.id FROM "sections" s CROSS JOIN "subjects" j
  ON CONFLICT DO NOTHING;
