-- Random id from the browser so a resent event (after a reconnect or page close) is stored only once.
ALTER TABLE "attempt_events" ADD COLUMN "client_id" VARCHAR(40);

-- CreateIndex
CREATE UNIQUE INDEX "attempt_events_attempt_id_client_id_key" ON "attempt_events"("attempt_id", "client_id");
