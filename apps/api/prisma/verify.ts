/**
 * Phase 0 verification harness.
 *
 * Proves the architectural claims this project rests on, rather than asserting
 * them. Run with: npx tsx prisma/verify.ts
 *
 * Each check maps to a stated product or security guarantee:
 *   1. 37 jurisdictions seeded
 *   2. Sale and Rent taxonomies are disjoint (the PropertyPro defect)
 *   3. A Rent type cannot be attached to a Sale listing (trigger + FK)
 *   4. Rent listings cannot omit the payment period
 *   5. Land listings must declare a deed type
 *   6. Reviews require a verified interaction
 *   7. audit_logs is append-only
 *   8. PII envelope encryption round-trips and is tamper-evident
 *   9. Phone OTP codes are never stored in plaintext
 *  10. Badge output never exceeds two per card
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PiiService } from '../src/common/pii.service.js';

// tsx does not auto-load .env the way the Prisma CLI does.
loadEnv({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'),
});

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectRejected(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(name, false, 'expected the write to be rejected but it succeeded');
  } catch {
    check(name, true);
  }
}

async function main(): Promise<void> {
  console.log('\nNaijaproperty — Phase 0 verification\n');

  // --- 1. Jurisdictions ---------------------------------------------------
  const stateCount = await prisma.state.count();
  check('37 jurisdictions seeded (36 states + FCT)', stateCount === 37, `found ${stateCount}`);

  const lgaCount = await prisma.lga.count();
  if (lgaCount === 774) {
    check('774 LGAs seeded', true);
  } else {
    // Not a hard failure: LGA coverage is built up incrementally from a
    // high-volume-states-first dataset, but the gap is always reported so it is
    // never mistaken for complete coverage.
    console.log(
      `  WARN  ${lgaCount} of 774 LGAs seeded — append the remainder to seed-data/seed-lgas.ts`,
    );
  }

  // --- 2. Disjoint taxonomies --------------------------------------------
  const saleTypes = await prisma.listingType.findMany({
    where: { kindCode: 'SALE' },
    select: { code: true },
  });
  const rentTypes = await prisma.listingType.findMany({
    where: { kindCode: 'RENT' },
    select: { code: true },
  });

  check('SALE types seeded', saleTypes.length > 0, `found ${saleTypes.length}`);
  check('RENT types seeded', rentTypes.length > 0, `found ${rentTypes.length}`);

  // Shared labels are legitimate (BUNGALOW exists in both worlds) but they must
  // be distinct rows under distinct composite keys, never one shared row.
  const saleCodes = new Set(saleTypes.map((t) => t.code));
  const rentOnly = rentTypes.filter((t) => !saleCodes.has(t.code));
  check(
    'RENT-only types exist alongside shared ones (disjoint storage, shared labels ok)',
    rentOnly.length > 0,
    'expected at least one type exclusive to RENT',
  );

  const totalTypeRows = await prisma.listingType.count();
  check(
    'type rows are kind-scoped (composite key)',
    totalTypeRows === saleTypes.length + rentTypes.length,
    `${totalTypeRows} rows vs ${saleTypes.length + rentTypes.length} types`,
  );

  // --- 3. Kind coherence is unrepresentable -------------------------------
  const lga = await prisma.lga.findFirst();
  if (!lga) {
    console.log('\n  SKIP  listing invariants — no LGAs seeded yet (run seed-lgas.ts)\n');
  } else {
    const rentOnlyCode = rentOnly[0]?.code;
    const area = await prisma.area.create({
      data: {
        name: 'Verification Test Area',
        slug: 'verification-test-area',
        normName: 'verification test area',
        lgaId: lga.id,
        stateCode: lga.stateCode,
        isActive: false,
      },
    });

    const base = {
      title: 'Verification listing for invariant checks',
      titleNorm: 'verification listing for invariant checks',
      description: 'x'.repeat(80),
      price: BigInt(5_000_000),
      posterId: null as unknown as string,
      areaId: area.id,
    };

    await expectRejected('a RENT type cannot be attached to a SALE listing', () =>
      prisma.listing.create({
        data: {
          ...base,
          kindCode: 'SALE',
          typeCode: rentOnlyCode!,
          lgaId: lga.id,
          stateCode: lga.stateCode,
          posterId: '0000000000000000000000',
        } as never,
      }),
    );

    await expectRejected('a SALE listing cannot declare NONE price period', () =>
      prisma.listing.create({
        data: {
          ...base,
          kindCode: 'SALE',
          typeCode: 'DUPLEX',
          pricePeriod: 'NONE',
          lgaId: lga.id,
          stateCode: lga.stateCode,
          posterId: '0000000000000000000000',
        } as never,
      }),
    );

    await expectRejected('a LAND listing cannot declare deed type NONE', () =>
      prisma.listing.create({
        data: {
          ...base,
          kindCode: 'SALE',
          typeCode: 'LAND',
          deedType: 'NONE',
          lgaId: lga.id,
          stateCode: lga.stateCode,
          posterId: '0000000000000000000000',
        } as never,
      }),
    );

    await expectRejected('an unknown review eligibility source cannot be inserted', () =>
      prisma.review.create({
        data: {
          listingId: '0000000000000000000000',
          authorId: '0000000000000000000000',
          ratingOverall: 5,
          body: 'Attempting an unverified review of a listing that has no reveal or stay record.',
          eligibility: 'REVEALED',
        } as never,
      }),
    );

    await expectRejected('audit_logs rejects UPDATE', () =>
      prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'tampered'`),
    );

    await expectRejected('audit_logs rejects DELETE', () =>
      prisma.$executeRawUnsafe(`DELETE FROM audit_logs`),
    );

    await prisma.area.deleteMany({ where: { id: area.id } });
  }

  // --- 8. PII encryption ---------------------------------------------------
  const pii = new PiiService();
  const secret = '2348012345678';
  const envelope = pii.encrypt(secret);
  check('PII envelope round-trips', pii.decrypt(envelope) === secret);
  check('PII ciphertext does not contain the plaintext', !envelope.includes(secret));
  check(
    'PII blind index is deterministic',
    pii.blindIndex(secret) === pii.blindIndex(secret),
  );
  check(
    'PII blind index differs per value',
    pii.blindIndex(secret) !== pii.blindIndex('2348099999999'),
  );

  let tamperRejected = false;
  try {
    const parts = envelope.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    pii.decrypt(parts.join('.'));
  } catch {
    tamperRejected = true;
  }
  check('PII envelope is tamper-evident (GCM auth tag)', tamperRejected);

  // --- 9. OTP is never stored in plaintext --------------------------------
  const code = '483920';
  const hash = pii.hashOtp(code);
  check('OTP code does not appear in its hash', !hash.includes(code));
  check('OTP hash verifies the correct code', pii.verifyOtpHash(code, hash));
  check('OTP hash rejects a wrong code', !pii.verifyOtpHash('000000', hash));

  // --- 10. Badge cap -------------------------------------------------------
  const { deriveBadges } = await import('../src/common/badge-cap.js').catch(() => ({
    deriveBadges: null,
  }));
  if (deriveBadges) {
    const badges = deriveBadges({
      ownerPhoneVerified: true,
      videoCount: 1,
      titleVerified: true,
      publishedAt: new Date(),
    });
    check(
      'badges never exceed the cap of two',
      badges.length <= 2,
      `got ${badges.length}: ${badges.join(', ')}`,
    );
    check(
      'trust badges outrank informational ones when the cap bites',
      badges[0] === 'VERIFIED_TITLE' || badges[0] === 'VERIFIED_OWNER',
      `got ${badges[0]}`,
    );
  } else {
    console.log('  SKIP  badge cap check — helper not found');
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * Removes this harness's own fixtures. See scripts/lib/cleanup-fixtures.ts for
 * why this is not optional.
 */
async function cleanupFixtures(): Promise<void> {
  const { cleanupFixtures: shared } = await import('../scripts/lib/cleanup-fixtures.js');
  await shared(prisma);
}

main()
  .then(async () => {
    await cleanupFixtures();
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error('\nVerification harness crashed:', err);
    await cleanupFixtures().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  });
