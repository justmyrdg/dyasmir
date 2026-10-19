-- AlterTable
-- Students choose their own password after signing in with one the teacher gave them.
ALTER TABLE "users" ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT false;
-- For the teacher's "Online now" page: the last authenticated request (written at most every 30 s) and sign-in.
ALTER TABLE "users" ADD COLUMN     "last_seen_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN     "last_login_at" TIMESTAMPTZ(6);

-- Every existing student still has a password the teacher set.
UPDATE "users" SET "must_change_password" = true WHERE "role" = 'student';
