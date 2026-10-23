-- CreateTable
CREATE TABLE "attempt_devices" (
    "id" SERIAL NOT NULL,
    "attempt_id" INTEGER NOT NULL,
    "device_key" VARCHAR(80) NOT NULL,
    "device_type" VARCHAR(10) NOT NULL,
    "os" VARCHAR(60) NOT NULL,
    "browser" VARCHAR(60) NOT NULL,
    "model" VARCHAR(80),
    "screen" VARCHAR(20),
    "touch" BOOLEAN,
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(500) NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attempt_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attempt_devices_device_key_idx" ON "attempt_devices"("device_key");

-- CreateIndex
CREATE UNIQUE INDEX "attempt_devices_attempt_id_device_key_key" ON "attempt_devices"("attempt_id", "device_key");

-- AddForeignKey
ALTER TABLE "attempt_devices" ADD CONSTRAINT "attempt_devices_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
