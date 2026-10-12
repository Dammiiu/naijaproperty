import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { PrismaService } from './common/prisma.service.js';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async health(): Promise<{ status: string; uptimeSeconds: number; version: string }> {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      version: process.env.npm_package_version ?? '0.1.0',
    };
  }

  /**
   * Readiness. Checks the database round-trip, because an API that cannot reach
   * Postgres must not receive traffic.
   */
  @Get('health/ready')
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async ready(): Promise<{ status: string; database: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ok' };
    } catch {
      return { status: 'degraded', database: 'unreachable' };
    }
  }
}
