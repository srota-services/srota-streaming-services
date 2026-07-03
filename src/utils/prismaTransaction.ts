import { Prisma, PrismaClient } from '@prisma/client';

type TransactionClient = Prisma.TransactionClient;

type PrismaLike = Pick<PrismaClient, '$transaction'>;

export async function runInTransaction<T>(
   prisma: PrismaLike,
   fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
   return prisma.$transaction(fn);
}

export async function runWrite<T>(
   prisma: PrismaLike,
   fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
   return runInTransaction(prisma, fn);
}

export type { TransactionClient };
