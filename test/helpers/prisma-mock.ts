import { mock } from 'bun:test';
import type { PrismaService } from '@/prisma/prisma.service';

export function createPrismaMock() {
  const prisma = {
    company: { findUnique: mock(), create: mock(), update: mock() },
    invoice: { findMany: mock(), findFirst: mock(), create: mock(), update: mock(), count: mock(), aggregate: mock(), groupBy: mock() },
    customer: { findUnique: mock(), findFirst: mock(), findMany: mock(), create: mock(), update: mock(), upsert: mock(), delete: mock(), count: mock() },
    auditLog: { create: mock(), findMany: mock(), count: mock() },
    $transaction: mock(),
    $queryRaw: mock(),
  };
  // Default: run the callback with the same mock as the transaction client
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  return prisma as typeof prisma & PrismaService;
}
