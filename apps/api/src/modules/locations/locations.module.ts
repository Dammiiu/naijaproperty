import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LocationsService } from './locations.service.js';
import { LocationsController } from './locations.controller.js';

// AuthModule is imported for JwtAuthGuard, which LocationsController uses to
// guard the area-proposal endpoint.
@Module({
  imports: [AuthModule],
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
