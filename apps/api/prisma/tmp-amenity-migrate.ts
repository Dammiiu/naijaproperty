/**
 * One-off: map demo-seed amenity codes onto the contract vocabulary.
 *
 * The seed wrote short local names (SECURITY, GATED, 24H_POWER...) that were never
 * in the closed vocabulary, so 23 listings could never match an amenity filter.
 * Each old code maps to the contract code that carries the same claim; a listing
 * can end up with two codes (SECURITY + GATED both becoming SECURITY_GATED), so
 * the result is de-duplicated.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
loadEnv({ path: resolve(process.cwd(), '.env') });
const prisma = new PrismaClient();

const MAP: Record<string, string[]> = {
  SECURITY: ['SECURITY_GATED'],
  GATED: ['SECURITY_GATED'],
  '24H_POWER': ['SECURITY_24H'],
  WATER: ['WATER_SUPPLY'],
  BQ: ['BOYS_QUARTERS'],
  GARDEN: ['GARDEN'],
  BALCONY: ['BALCONY'],
  ELECTRICITY: ['SERVICED'],
};

const CONTRACT = [
  'SECURITY_24H','SECURITY_GATED','SECURITY_FLOODED','GENERATOR','SOLAR','INVERTER','BOREHOLE',
  'WATER_SUPPLY','SWIMMING_POOL','GYM','LIFT','PARKING','FURNISHED','SERVICED','NEWLY_BUILT',
  'CLUBHOUSE','PLAYGROUND','COMMUNITY_HALL','WASTAGE_DISPOSAL','EV_CHARGING','SMART_HOME',
  'GARDEN','BALCONY','BOYS_QUARTERS','FENCED','PAVED_ROAD','CORNER_LOT',
];

async function main() {
  const rows = await prisma.listing.findMany({ select: { id: true, amenities: true, title: true } });
  let changed = 0;

  for (const row of rows) {
    const out: string[] = [];
    for (const code of row.amenities) {
      const mapped = MAP[code] ?? [code];
      for (const m of mapped) if (!out.includes(m)) out.push(m);
    }
    // Anything still not in the vocabulary would silently break filtering again,
    // so drop it and report rather than write a code we cannot filter on.
    const valid = out.filter((c) => CONTRACT.includes(c));
    const dropped = out.filter((c) => !CONTRACT.includes(c));
    if (dropped.length) console.log('  dropped unfilterable:', dropped.join(', '), 'on', row.title.slice(0, 30));

    if (JSON.stringify(valid) === JSON.stringify(row.amenities)) continue;
    await prisma.listing.update({ where: { id: row.id }, data: { amenities: valid } });
    changed += 1;
  }
  console.log(`rewrote ${changed} of ${rows.length} listings`);

  const after = await prisma.listing.findMany({ select: { amenities: true } });
  const codes = new Set(after.flatMap((r) => r.amenities));
  const outside = [...codes].filter((c) => !CONTRACT.includes(c));
  console.log('codes now in use:', codes.size, '| outside the contract:', outside.length ? outside.join(', ') : 'none');
  await prisma.$disconnect();
}
main();