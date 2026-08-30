-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('HELD', 'CONFIRMED', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "dealership" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dealership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_hour" (
    "id" UUID NOT NULL,
    "dealership_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "open_minute" INTEGER NOT NULL,
    "close_minute" INTEGER NOT NULL,

    CONSTRAINT "opening_hour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_type" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,

    CONSTRAINT "service_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_bay" (
    "id" UUID NOT NULL,
    "dealership_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "service_bay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bay_capability" (
    "service_bay_id" UUID NOT NULL,
    "service_type_id" UUID NOT NULL,

    CONSTRAINT "bay_capability_pkey" PRIMARY KEY ("service_bay_id","service_type_id")
);

-- CreateTable
CREATE TABLE "technician" (
    "id" UUID NOT NULL,
    "dealership_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "technician_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_skill" (
    "technician_id" UUID NOT NULL,
    "service_type_id" UUID NOT NULL,

    CONSTRAINT "technician_skill_pkey" PRIMARY KEY ("technician_id","service_type_id")
);

-- CreateTable
CREATE TABLE "technician_shift" (
    "id" UUID NOT NULL,
    "technician_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,

    CONSTRAINT "technician_shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "vin" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment" (
    "id" UUID NOT NULL,
    "dealership_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "service_type_id" UUID NOT NULL,
    "technician_id" UUID NOT NULL,
    "service_bay_id" UUID NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "hold_expires_at" TIMESTAMPTZ(6),
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "opening_hour_dealership_id_day_of_week_key" ON "opening_hour"("dealership_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "service_type_name_key" ON "service_type"("name");

-- CreateIndex
CREATE UNIQUE INDEX "service_bay_dealership_id_name_key" ON "service_bay"("dealership_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "technician_shift_technician_id_day_of_week_key" ON "technician_shift"("technician_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "customer_email_key" ON "customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_vin_key" ON "vehicle"("vin");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_idempotency_key_key" ON "appointment"("idempotency_key");

-- CreateIndex
CREATE INDEX "appointment_dealership_id_start_at_idx" ON "appointment"("dealership_id", "start_at");

-- CreateIndex
CREATE INDEX "appointment_customer_id_start_at_idx" ON "appointment"("customer_id", "start_at");

-- CreateIndex
CREATE INDEX "outbox_event_published_at_created_at_idx" ON "outbox_event"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "opening_hour" ADD CONSTRAINT "opening_hour_dealership_id_fkey" FOREIGN KEY ("dealership_id") REFERENCES "dealership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_bay" ADD CONSTRAINT "service_bay_dealership_id_fkey" FOREIGN KEY ("dealership_id") REFERENCES "dealership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bay_capability" ADD CONSTRAINT "bay_capability_service_bay_id_fkey" FOREIGN KEY ("service_bay_id") REFERENCES "service_bay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bay_capability" ADD CONSTRAINT "bay_capability_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_type"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician" ADD CONSTRAINT "technician_dealership_id_fkey" FOREIGN KEY ("dealership_id") REFERENCES "dealership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_skill" ADD CONSTRAINT "technician_skill_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technician"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_skill" ADD CONSTRAINT "technician_skill_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_type"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_shift" ADD CONSTRAINT "technician_shift_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technician"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_dealership_id_fkey" FOREIGN KEY ("dealership_id") REFERENCES "dealership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_service_bay_id_fkey" FOREIGN KEY ("service_bay_id") REFERENCES "service_bay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
