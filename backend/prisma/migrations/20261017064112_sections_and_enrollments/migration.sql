-- CreateTable
CREATE TABLE "student_subjects" (
    "student_id" INTEGER NOT NULL,
    "subject_id" INTEGER NOT NULL,

    CONSTRAINT "student_subjects_pkey" PRIMARY KEY ("student_id","subject_id")
);

-- CreateIndex
CREATE INDEX "student_subjects_subject_id_idx" ON "student_subjects"("subject_id");

-- AddForeignKey
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Real section names: A/B/C -> BCpET3101/3102/3103 (ids, and everything linked to them, stay the same).
-- ---------------------------------------------------------------------------
UPDATE "sections" SET "name" = 'BCpET3101' WHERE "name" = 'A';
UPDATE "sections" SET "name" = 'BCpET3102' WHERE "name" = 'B';
UPDATE "sections" SET "name" = 'BCpET3103' WHERE "name" = 'C';
INSERT INTO "sections" ("name") VALUES ('BCpET3101'), ('BCpET3102'), ('BCpET3103') ON CONFLICT DO NOTHING;
INSERT INTO "section_subjects" ("section_id", "subject_id")
  SELECT s.id, j.id FROM "sections" s CROSS JOIN "subjects" j
  ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Enrollment rules: only students, and only in a subject their section offers.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "check_student_subject"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  urole TEXT;
  usection INTEGER;
BEGIN
  SELECT "role", "section_id" INTO urole, usection FROM "users" WHERE "id" = NEW.student_id;
  IF urole IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'Only students can be enrolled in subjects (user %)', NEW.student_id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "section_subjects" WHERE "section_id" = usection AND "subject_id" = NEW.subject_id) THEN
    RAISE EXCEPTION 'Subject % is not offered to the section of student %', NEW.subject_id, NEW.student_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "student_subjects_valid"
  BEFORE INSERT OR UPDATE ON "student_subjects"
  FOR EACH ROW EXECUTE FUNCTION "check_student_subject"();

-- Existing students keep seeing everything they saw before: enroll them in all subjects of their section.
INSERT INTO "student_subjects" ("student_id", "subject_id")
  SELECT u.id, ss.subject_id
  FROM "users" u JOIN "section_subjects" ss ON ss.section_id = u.section_id
  WHERE u.role = 'student'
  ON CONFLICT DO NOTHING;
