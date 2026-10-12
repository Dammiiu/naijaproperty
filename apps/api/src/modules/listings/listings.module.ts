import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { SearchModule } from '../search/search.module.js';
import { ListingsService } from './listings.service.js';
import {
  AdminListingsController,
  ListingsController,
} from './listings.controller.js';
import { ListingDetailController } from './listing-detail.controller.js';
import { MyListingsController } from './my-listings.controller.js';
import { RevealService } from './reveal.service.js';

@Module({
  imports: [AuthModule, LocationsModule, SearchModule],
  controllers: [
    ListingsController,
    ListingDetailController,
    MyListingsController,
    AdminListingsController,
  ],
  providers: [ListingsService, RevealService],
  exports: [ListingsService, RevealService],
})
export class ListingsModule {}
