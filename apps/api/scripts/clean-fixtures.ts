/**
 * Removes verification-harness fixtures from the live browse surface.
 *
 * Why this exists:
 *
 * The `verify:*` harnesses create real listings against the live database. They
 * cannot delete the *users* afterwards, because `audit_logs` is append-only by
 * trigger and a user with audit history is refused by Postgres. That part is
 * correct behaviour and is left alone.
 *
 * But the users were left `SUSPENDED` while their LISTINGS stayed `ACTIVE`, so
 * `poster.phase1` ended up owning 124 of the 144 live listings. The browse page
 * was therefore 86% one test account's fixtures, all with identical titles and
 * prices, which looked exactly like a broken search query. It was not: search
 * was faithfully returning the contents of the database.
 *
 * This script deletes the harness listings and demotes the harness accounts.
 * Demo seed data (`demo.*@listers.ng`) is never touched.
 *
 *   npm run clean:fixtures -w @naijaproperty/api
 */

import { config as loadEnv } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });

const prisma = new PrismaClient();

/**
 * Accounts created by the harnesses.
 *
 * Matched on the `@naijaproperty.local` domain, which the seed and the real
 * fixtures never use, rather than on a hardcoded list. A new harness or a new
 * fixture is therefore covered automatically, and there is no list here to fall
 * out of date.
 */
const FIXTURE_EMAIL_DOMAIN = '@naijaproperty.local';

async function main() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: FIXTURE_EMAIL_DOMAIN } },
    select: { id: true, email: true, status: true, _count: { select: { listings: true } } },
  });

  if (users.length === 0) {
    console.log('No fixture accounts found. Nothing to clean.');
    return;
  }

  const userIds = users.map((u) => u.id);
  const listingCount = users.reduce((sum, u) => sum + u._count.listings, 0);

  console.log(`Found ${users.length} fixture account(s) owning ${listingCount} listing(s):`);
  for (const u of users) {
    console.log(`  ${u.status.padEnd(9)} ${String(u._count.listings).padStart(4)}  ${u.email}`);
  }

  /*
   * Media first.
   *
   * ListingMedia rows cascade from Listing, so the join table clears itself, but
   * the MediaAsset rows it points at do not: nothing in the schema owns them once
   * the listing is gone. They would otherwise accumulate as orphans forever, which
   * is exactly how 266 unattachable images accumulated here.
   */
  const mediaIds = await prisma.mediaAsset.findMany({
    where: { listingMedia: { some: { listing: { posterId: { in: userIds } } } } },
    select: { id: true },
  });

  const orphanMedia = await prisma.mediaAsset.findMany({
    where: { listingMedia: { none: {} }, ownerId: { in: userIds } },
    select: { id: true },
  });

  const allMediaIds = [...new Set([...mediaIds, ...orphanMedia].map((m) => m.id))];

  const deleted = await prisma.listing.deleteMany({ where: { posterId: { in: userIds } } });
  console.log(`\nDeleted ${deleted.count} fixture listing(s).`);

  if (allMediaIds.length > 0) {
    await prisma.mediaAsset.deleteMany({ where: { id: { in: allMediaIds } } });
    console.log(`Deleted ${allMediaIds.length} fixture media asset(s).`);
  }

  /*
   * The accounts themselves are suspended rather than deleted, because audit_logs
   * is append-only and deleting a user with audit history is refused by Postgres.
   * Suspension is also the safer outcome: the fixture ids stay stable across runs,
   * so any assertion comparing them still holds.
   */
  const suspended = await prisma.user.updateMany({
    where: { id: { in: userIds }, status: { not: 'SUSPENDED' } },
    data: { status: 'SUSPENDED' },
  });
  console.log(`Suspended ${suspended.count} fixture account(s) that were still active.`);

  // Report what the browse surface looks like now.
  const live = await prisma.listing.groupBy({ by: ['kindCode'], _count: true });
  console.log('\nLive listings by kind:');
  for (const row of live) console.log(`  ${row.kindCode}: ${row._count}`);

  const stillActive = await prisma.user.count({
    where: { id: { in: userIds }, status: 'ACTIVE' },
  });
  if (stillActive > 0) {
    console.error(`\n${stillActive} fixture account(s) are still ACTIVE.`);
    process.exitCode = 1;
    return;
  }

  console.log('\nClean. The browse surface now contains only demo and user-posted listings.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
