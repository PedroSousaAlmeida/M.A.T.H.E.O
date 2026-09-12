-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('TRIAL', 'ACTIVE');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN "plan" "Plan" NOT NULL DEFAULT 'TRIAL';
ALTER TABLE "companies" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
UPDATE "companies" SET "trialEndsAt" = "createdAt" + INTERVAL '30 days' WHERE "trialEndsAt" IS NULL;
ALTER TABLE "companies" ALTER COLUMN "trialEndsAt" SET NOT NULL;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "customerId" TEXT;

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "email" TEXT,
    "telefone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_companyId_nome_idx" ON "customers"("companyId", "nome");

-- CreateIndex
CREATE UNIQUE INDEX "customers_companyId_documento_key" ON "customers"("companyId", "documento");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
