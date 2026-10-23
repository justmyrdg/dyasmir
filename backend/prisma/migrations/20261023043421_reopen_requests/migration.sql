-- CreateTable
CREATE TABLE "reopen_requests" (
    "id" SERIAL NOT NULL,
    "attempt_id" INTEGER NOT NULL,
    "message" VARCHAR(500),
    "status" VARCHAR(10) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "reopen_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reopen_requests_attempt_id_idx" ON "reopen_requests"("attempt_id");

-- CreateIndex
CREATE INDEX "reopen_requests_status_idx" ON "reopen_requests"("status");

-- AddForeignKey
ALTER TABLE "reopen_requests" ADD CONSTRAINT "reopen_requests_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints (not expressible in schema.prisma); same list as ReopenRequestStatus in src/attempts/security.ts.
ALTER TABLE "reopen_requests" ADD CONSTRAINT "reopen_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'declined'));
ALTER TABLE "reopen_requests" ADD CONSTRAINT "reopen_requests_resolved" CHECK (("status" = 'pending') = ("resolved_at" IS NULL));
