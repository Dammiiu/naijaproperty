import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SearchService } from './search.service.js';
import { SearchController } from './search.controller.js';
import { SavedSearchController } from './saved-search.controller.js';

/**
 * AuthModule is required because SavedSearchController uses JwtAuthGuard, which
 * injects AuthService. Guards are resolved in the module that declares them, not
 * globally, so omitting this fails at boot rather than at the first request.
 */
@Module({
  imports: [AuthModule],
  controllers: [SearchController, SavedSearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}