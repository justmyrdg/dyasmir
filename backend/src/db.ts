import { Prisma, PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

/** The database server's current time. All schedule/deadline checks use this, never the client clock. */
export async function dbNow(db: Db = prisma): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return rows[0].now;
}
