import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AuthModule } from '../auth/auth.module.js';

/**
 * Admin console backend.
 *
 * Separate module from listings so the guard stack is visibly distinct: every
 * route here is staff-only, and the review workflow that already existed on the
 * listings module stays where it was rather than being moved underneath anyone
 * relying on it.
 *
 * AuthModule must be imported: JwtAuthGuard injects AuthService, and guards are
 * resolved in the module that declares them rather than the global one.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminController],
})
export class AdminModule {}