/**
 * Shared fixture cleanup for the verification harnesses.
 *
 * The harnesses create real listings against the live database, because testing
 * against a stub would not test the invariants that matter. The cost of that is
 * that they leave data behind.
 *
 * That cost was paid in a way nobody noticed for a long time: every run of
 * `verify:phase1` added listings for `poster.phase1`, the accounts were
 * suspended but the listings stayed `LIVE`, and the browse page came to be 86%
 * one test account's fixtures. Eighteen cards in a row read as a single listing
 * spanning the grid, which looks exactly like a broken search query and is not
 * one at all.
 *
 * Every harness therefore calls `cleanupFixtures` on both the success and the
 * failure path. Accounts are suspended rather than deleted, because `audit_logs`
 * is append-only by trigger and Postgres refuses to delete a user that has audit
 * history. Listings and media are deleted outright: nothing else depends on them,
 * and orphan media is what silently accumulated to 266 unattachable images.
 */

import type { PrismaClient } from '@prisma/client';

/** Domain used only by the harnesses. The demo seed never uses it. */
const FIXTURE_EMAIL_DOMAIN = '@naijaproperty.local';

export async function cleanupFixtures(prisma: PrismaClient): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      where: { email: { endsWith: FIXTURE_EMAIL_DOMAIN } },
      select: { id: true },
    });
    if (users.length === 0) return;
    const userIds = users.map((u) => u.id);

    const media = await prisma.mediaAsset.findMany({
      where: { ownerId: { in: userIds } },
      select: { id: true },
    });
    const mediaIds = media.map((m) => m.id);

    const listings = await prisma.listing.deleteMany({ where: { posterId: { in: userIds } } });

    if (mediaIds.length > 0) {
      await prisma.mediaAsset.deleteMany({ where: { id: { in: mediaIds } } });
    }

    await prisma.user.updateMany({
      where: { id: { in: userIds }, status: { not: 'SUSPENDED' } },
      data: { status: 'SUSPENDED' },
    });

    console.log(
      `  cleanup: removed ${listings.count} fixture listing(s) and ${mediaIds.length} media asset(s)`,
    );
  } catch (err) {
    // Cleanup must never mask the harness's own result.
    console.warn('  cleanup: could not remove fixtures:', (err as Error).message);
  }
}
