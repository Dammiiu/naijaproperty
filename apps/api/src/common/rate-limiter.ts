/**
 * Fixed-window rate limiter for budgets that need their own rules, separate
 * from the declarative @nestjs/throttler guards.
 *
 * Backed by Postgres rather than Redis so counters survive an API restart and
 * so Phase 0 correctness does not depend on Redis being up. The method surface
 * is deliberately Redis-shaped, so moving the backend later is a contained
 * change.
 *
 * `consume` both reads and increments in one statement, which removes the
 * read-then-write race that would otherwise let concurrent requests slip past
 * a cap.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service.js';

const DEFAULT_WINDOW_MS = 3_600_000; // one hour

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically consumes `cost` units and returns the resulting total.
   * Throws `RateLimitExceededError` when the window's budget is exhausted.
   */
  async consume(
    key: string,
    limit: number,
    cost = 1,
    windowMs = DEFAULT_WINDOW_MS,
  ): Promise<{ total: number; remaining: number }> {
    const windowStart = windowFloor(Date.now(), windowMs);

    let total: number;

    try {
      const rows = await this.prisma.$queryRaw<Array<{ count: bigint | number }>>(Prisma.sql`
        INSERT INTO rate_limit_counters (key, window_start, count, updated_at)
        VALUES (${key}, ${windowStart}, ${cost}, now())
        ON CONFLICT (key, window_start)
          DO UPDATE SET count = rate_limit_counters.count + ${cost}, updated_at = now()
        RETURNING count
      `);

      // `count` is a BIGINT column, so Prisma returns a JS BigInt. It must be
      // converted before any arithmetic: mixing BigInt and Number throws a
      // TypeError, which previously surfaced as a misleading 429 because the
      // caller reported any rejection from this method as a rate-limit breach.
      const raw = rows[0]?.count;
      total = typeof raw === 'bigint' ? Number(raw) : (raw ?? cost);
    } catch (err) {
      // A limiter outage must not become a bypass. Fail closed.
      this.logger.error(`Rate limit failed for ${key}: ${(err as Error).message}`);
      throw new RateLimitExceededError(Math.ceil(windowMs / 1000));
    }

    if (total > limit) {
      throw new RateLimitExceededError(Math.ceil(windowMs / 1000));
    }

    return { total, remaining: Math.max(0, limit - total) };
  }

  /**
   * Reads the current window total without consuming. Used for the
   * already-unlocked path, which must not be charged twice.
   */
  async peek(key: string, windowMs = DEFAULT_WINDOW_MS): Promise<number> {
    const windowStart = windowFloor(Date.now(), windowMs);
    try {
      const rows = await this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT count FROM rate_limit_counters
        WHERE key = ${key} AND window_start = ${windowStart}
      `);
      return rows[0]?.count ?? 0;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  async purgeExpired(windowMs = DEFAULT_WINDOW_MS): Promise<number> {
    const cutoff = new Date(windowFloor(Date.now(), windowMs).getTime() - windowMs);
    return this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM rate_limit_counters WHERE window_start < ${cutoff}`,
    );
  }
}

export class RateLimitExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Rate limit exceeded');
    this.name = 'RateLimitExceededError';
  }
}

/** Floors a timestamp to the start of its fixed window. */
function windowFloor(now: number, windowMs: number): Date {
  return new Date(Math.floor(now / windowMs) * windowMs);
}
