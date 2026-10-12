import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SearchService } from './search.service.js';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * Public browse. No authentication, and deliberately cheap to call: this is
   * the endpoint a crawler, a share preview, and a returning buyer all hit.
   *
   * It cannot leak an exact address or a phone number, because the serializer's
   * column list omits both.
   */
  @Get('listings')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Search live listings. `kind` is required.' })
  async listings(@Query() query: Record<string, unknown>) {
    await this.search.warmTypeLabels();
    return this.search.search(query);
  }

  @Get('areas')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Fuzzy area suggestions from name or known alias' })
  async areas(
    @Query('q') q: string,
    @Query('stateCode') stateCode?: string,
  ) {
    return this.search.suggestAreas(String(q ?? ''), stateCode);
  }
}
