import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FavouritesController } from './favourites.controller.js';

/**
 * AuthModule is required because the controller uses JwtAuthGuard, which
 * injects AuthService. Guards resolve in the declaring module, not globally.
 */
@Module({
  imports: [AuthModule],
  controllers: [FavouritesController],
})
export class FavouritesModule {}