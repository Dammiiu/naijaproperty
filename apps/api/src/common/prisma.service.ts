import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Single Prisma client for the API service. The API is the only process that
 * touches the database; web and mobile go through HTTP.
 */
type PrismaLogLevel = 'query' | 'warn' | 'error';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const isDev = process.env.NODE_ENV !== 'production';
    super({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: isDev
        ? [{ emit: 'event', level: 'error' as PrismaLogLevel }]
        : [{ emit: 'event', level: 'error' as PrismaLogLevel }],
      errorFormat: isDev ? 'pretty' : 'minimal',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Wraps a transaction. Used for writes that must stay consistent across
   * tables, e.g. contact reveal which must write the audit row and create the
   * conversation atomically.
   */
  /**
   * Wraps a transaction. The callback receives an interactive transaction
   * client, which is intentionally narrower than the full PrismaClient (no
   * nested `$transaction`, `$connect`, etc). Using `tx` rather than the injected
   * service inside a transaction is what makes writes atomic.
   */
  async transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(fn, {
      maxWait: 5_000,
      timeout: 15_000,
      isolationLevel: 'ReadCommitted',
    });
  }
}
