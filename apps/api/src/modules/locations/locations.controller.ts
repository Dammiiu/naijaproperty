import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiException, proposeAreaSchema, proposeLgaSchema } from '@naijaproperty/contracts';
import { LocationsService } from './locations.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Alias-aware autocomplete. Resolves "Egbeda", "Ikeja GRA" and "Adamu Baulkura"
   * to canonical areas via area_alias plus trigram similarity, which is what makes
   * informal Nigerian locality names searchable.
   */
  @Get('areas/suggest')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Autocomplete areas by name or known alias' })
  async suggest(@Query() query: Record<string, unknown>) {
    return this.locations.suggest(query);
  }

  /**
   * Areas within one LGA.
   *
   * Backs the post form's third dropdown. Autocomplete is better when the poster
   * knows the informal name, but a poster who does not would be stuck staring at
   * an empty type-ahead, so the form needs to be able to enumerate what exists.
   *
   * Inactive areas are included, and flagged rather than hidden. A poster who
   * proposed an area must still be able to file against it — hiding it would
   * silently push them into proposing a duplicate of their own area.
   */
  @Get('areas')
  @ApiOperation({ summary: 'Areas within an LGA, active and proposed' })
  async areasInLga(@Query('lgaId') lgaId?: string) {
    if (!lgaId) {
      throw ApiException.validation([
        { path: 'lgaId', message: 'An LGA is required to list its areas' },
      ]);
    }

    const parsed = z.string().cuid().safeParse(lgaId);
    if (!parsed.success) {
      throw ApiException.validation([{ path: 'lgaId', message: 'Invalid LGA' }]);
    }

    return this.prisma.area.findMany({
      where: { lgaId: parsed.data },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      take: 500,
      select: {
        id: true,
        name: true,
        lgaId: true,
        isActive: true,
        proposalCount: true,
        _count: { select: { listings: { where: { status: 'LIVE' } } } },
      },
    });
  }

  @Get('states')
  @ApiOperation({ summary: 'All 36 states and the FCT' })
  async states() {
    return this.prisma.state.findMany({
      orderBy: { name: 'asc' },
      select: {
        code: true,
        name: true,
        slug: true,
        _count: { select: { areas: { where: { isActive: true } } } },
      },
    });
  }

  @Get('lgas')
  @ApiOperation({ summary: 'LGAs, optionally filtered by state' })
  async lgas(@Query('stateCode') stateCode?: string) {
    return this.prisma.lga.findMany({
      where: stateCode ? { stateCode: stateCode.toUpperCase() } : undefined,
      orderBy: { name: 'asc' },
      select: {
        code: true,
        id: true,
        name: true,
        stateCode: true,
        // Pending LGAs are returned too, on purpose: this endpoint backs the post
        // form, and a poster who proposed one must keep seeing what they typed
        // rather than have the field silently reset. Public search facets read
        // isActive separately, so an uncurated name cannot leak into them.
        isActive: true,
        _count: { select: { areas: { where: { isActive: true } } } },
      },
      take: 800,
    });
  }

  /** Listing types for a kind. This is what makes rent and sale facets disjoint. */
  @Get('listing-types')
  @ApiOperation({ summary: 'Property types available for a given kind' })
  async types(@Query('kind') kind: string) {
    const code = kind?.toUpperCase();
    if (code !== 'SALE' && code !== 'RENT') {
      throw ApiException.validation([
        { path: 'kind', message: 'Kind must be SALE or RENT' },
      ]);
    }
    return this.prisma.listingType.findMany({
      where: { kindCode: code },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, label: true, requiresBedrooms: true, requiresPlotSize: true },
    });
  }

  /**
   * Proposes an area a poster referenced that does not exist yet. Requires auth
   * because it writes rows an admin must later curate.
   */
  @Post('areas/propose')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Propose a new area for admin curation' })
  async propose(@Body() body: unknown) {
    const parsed = proposeAreaSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiException.validation(
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return this.locations.propose(parsed.data);
  }

  /**
   * Records an LGA a poster named that we do not have yet.
   *
   * The area endpoint exists but was not enough: without an LGA there is nowhere
   * to hang an area either, so a landlord outside the reference data could not
   * list at all. Refusing is the wrong answer for a country that creates LGAs
   * faster than reference tables here are updated.
   */
  @Post('lgas/propose')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Propose a local government area for admin curation' })
  async proposeLga(@Body() body: unknown) {
    const parsed = proposeLgaSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiException.validation(
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return this.locations.proposeLga(parsed.data);
  }
}
