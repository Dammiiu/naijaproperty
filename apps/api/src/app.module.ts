import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard } from './common/throttler.guard.js';
import { PrismaService } from './common/prisma.service.js';
import { PiiService } from './common/pii.service.js';
import { PasswordService, OtpService } from './common/crypto.service.js';
import { RateLimiterService } from './common/rate-limiter.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { OtpModule } from './modules/otp/otp.module.js';
import { MediaModule } from './modules/media/media.module.js';
import { ListingsModule } from './modules/listings/listings.module.js';
import { LocationsModule } from './modules/locations/locations.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { FavouritesModule } from './modules/favourites/favourites.module.js';
import { MessagesModule } from './modules/messages/messages.module.js';
import { HealthController } from './health.controller.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';

/**
 * Root module.
 *
 * Rate limiting is global at a permissive default and tightened per-endpoint via
 * @Throttle on auth, reveal, upload and review routes. 120/min is generous for
 * browsing but low enough that a scraper cannot enumerate contact reveals.
 */
@Global()
@Module({
  imports: [
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 120 },
      { name: 'strict', ttl: 60_000, limit: 10 },
    ]),
  ],
  providers: [
    PrismaService,
    PiiService,
    PasswordService,
    OtpService,
    RateLimiterService,
    {
      provide: APP_GUARD,
      useClass: AppThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
  exports: [
    PrismaService,
    PiiService,
    PasswordService,
    OtpService,
    RateLimiterService,
    ScheduleModule,
  ],
})
export class CoreModule {}

@Module({
  imports: [
    CoreModule,
    AuthModule,
    OtpModule,
    MediaModule,
    ListingsModule,
    LocationsModule,
    SearchModule,
    AdminModule,
    FavouritesModule,
    MessagesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
