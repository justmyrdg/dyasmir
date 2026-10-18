-- Each enrollment records the section the student takes that subject in.
-- (An irregular student can take Database Design with one section and Embedded Systems with another.)

-- Add the column, fill it with the student's own section, then require it.
ALTER TABLE "student_subjects" ADD COLUMN "section_id" INTEGER;
UPDATE "student_subjects" en SET "section_id" = u."section_id" FROM "users" u WHERE u."id" = en."student_id";
ALTER TABLE "student_subjects" ALTER COLUMN "section_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "student_subjects_section_id_subject_id_idx" ON "student_subjects"("section_id", "subject_id");

-- AddForeignKey
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The section must offer the subject (replaces the trigger's section check).
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_section_id_subject_id_fkey" FOREIGN KEY ("section_id", "subject_id") REFERENCES "section_subjects"("section_id", "subject_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The trigger now only checks that the user is a student.
CREATE OR REPLACE FUNCTION "check_student_subject"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT "role" FROM "users" WHERE "id" = NEW.student_id) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'Only students can be enrolled in subjects (user %)', NEW.student_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
