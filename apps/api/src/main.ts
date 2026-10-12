import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { AppModule } from './app.module.js';
import { getEnv, isProduction } from './config/env.js';
import { PrismaService } from './common/prisma.service.js';

async function bootstrap(): Promise<void> {
  // Validate configuration before anything else so a missing secret fails fast
  // and loudly rather than at the first request.
  const env = getEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false,
      bodyLimit: 2 * 1024 * 1024,
      trustProxy: true,
      requestIdHeader: 'x-request-id',
    }),
    {
      // Exposes the unparsed body on `request.rawBody`, which the Termii webhook
      // handler needs: the HMAC-SHA512 signature is computed over the exact bytes
      // received, and re-serialising the parsed JSON would change them. This is a
      // Nest factory option, not a Fastify one, and does not replace the parser.
      rawBody: true,
    },
  );

  // `useLogger` takes a set of enabled levels ordered most to least severe, so we
// slice our configured level from a canonical ladder. Our env schema uses
// `info` where Nest names it `log`.
  const NEST_LOG_LADDER = ['error', 'warn', 'log', 'debug'] as const;
  const configured = env.LOG_LEVEL === 'info' ? 'log' : env.LOG_LEVEL;
  const threshold = NEST_LOG_LADDER.indexOf(
    configured as (typeof NEST_LOG_LADDER)[number],
  );
  app.useLogger(NEST_LOG_LADDER.slice(threshold < 0 ? 1 : threshold));

  // Verification harnesses drive the API from a single IP, which the auth rate
  // limits correctly read as abuse. NJP_E2E=1 raises every budget so the harness
  // measures product behaviour rather than its own rate limiting. Per-endpoint
  // @Throttle decorators still apply; only the numbers change.
  //
  // Hard-gated on non-production and evaluated at boot, so it can never be enabled
  // on a deployed environment.
  const e2e = process.env.NJP_E2E === '1';
  if (e2e && env.NODE_ENV === 'production') {
    throw new Error('NJP_E2E must never be enabled in production');
  }

  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready'] });

  // Note on request bodies: several endpoints are legitimately bodyless
  // (POST /listings/:id/submit, POST /auth/logout, POST /media/images/complete
  // without a client hash). Fastify rejects a request that declares
  // `content-type: application/json` but sends zero bytes, so clients must either
  // omit the header or send `{}`. packages/client already sends `{}` for these
  // routes, and the Zod schemas accept it. Replacing the parser to allow empty
  // bodies was attempted and abandoned: calling `app.init()` manually to register
  // a replacement causes Nest to re-resolve routes without the global prefix.
  //
  // `rawBody: true` (Nest factory option) gives the Termii webhook handler the
  // unparsed bytes it needs for HMAC verification, without replacing the parser.

  await app.register(cookie);

  await app.register(helmet, {
    // The API serves JSON and media presigns; it never renders HTML, so CSP is
    // handled at the web tier.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: isProduction()
      ? [env.WEB_URL]
      : [env.WEB_URL, 'http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: false, // enforced by @nestjs/throttler so limits are declarative
    keyGenerator: (req) => req.ip,
  });


  // No global ValidationPipe: every endpoint validates its body with the Zod
  // schemas in @naijaproperty/contracts, which are shared with the web and
  // mobile clients. A class-validator pipe would mean a second, divergent set of
  // validation rules per DTO, and would allow the same route to accept different
  // shapes depending on which decorator was applied.

  app.enableShutdownHooks();

  const logger = new Logger('Bootstrap');
  if (e2e) logger.warn('NJP_E2E=1 — rate limits are raised for this process');

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  logger.log(`Naijaproperty API listening on ${env.API_URL}`);
  logger.log(`Environment: ${env.NODE_ENV}`);
  if (!isProduction()) {
    logger.log(
      `Termii WhatsApp OTP: ${env.TERMII_WHATSAPP_FROM ? 'configured' : 'not configured (SMS fallback only)'}`,
    );
    logger.log(`SMTP: ${env.SMTP_HOST ? 'configured' : 'not configured'}`);
    logger.log(`Google OAuth: ${env.GOOGLE_CLIENT_ID ? 'configured' : 'not configured'}`);
  }

  const prisma = app.get(PrismaService);
  void prisma;
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
