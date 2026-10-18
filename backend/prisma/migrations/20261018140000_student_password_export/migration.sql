-- AlterTable
-- The student's current password, encrypted (AES-256-GCM) with CREDENTIALS_KEY from the server's .env,
-- so the teacher can export or email it. The key is never stored in the database or its backups.
ALTER TABLE "users" ADD COLUMN     "password_encrypted" TEXT;
