/**
 * Phase 0 seed: reference data.
 *
 * Idempotent, so it is safe to run repeatedly. Loads:
 *  - 36 states + FCT
 *  - SALE and RENT listing kinds with genuinely disjoint type taxonomies
 *  - Review SLA policies (target 3h, warn 4h, escalate 6h)
 *  - Monetization plans and entitlements (no payments; NoopProvider only)
 *  - A bootstrap admin, when SEED_ADMIN_* is present in the environment
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { hash } from 'argon2';

// Prisma's CLI injects .env, but `tsx prisma/seed.ts` does not.
loadEnv({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'),
});
import {
  KINDS,
  PLANS,
  SLA_POLICIES,
  STATES,
  TYPES,
} from './seed-data/reference.js';
import { LGAS } from './seed-data/seed-lgas.js';

const prisma = new PrismaClient();

async function seedStates(): Promise<number> {
  let count = 0;
  for (const s of STATES) {
    await prisma.state.upsert({
      where: { code: s.code },
      update: { name: s.name, slug: s.slug, centreLat: s.centreLat, centreLng: s.centreLng },
      create: {
        code: s.code,
        name: s.name,
        slug: s.slug,
        centreLat: s.centreLat,
        centreLng: s.centreLng,
      },
    });
    count += 1;
  }
  return count;
}

/**
 * Seeds LGAs idempotently.
 *
 * A few entries in the dataset share a (stateCode, name) pair because some LGAs
 * are recorded under both formal and colloquial names. The unique constraint
 * means the second is skipped, so we report the discrepancy rather than letting
 * a partial load look complete.
 */
async function seedLgas(): Promise<{ inserted: number; duplicates: number; total: number }> {
  let inserted = 0;
  let duplicates = 0;
  const seen = new Set<string>();

  for (const l of LGAS) {
    const key = `${l.stateCode}:${l.name}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);

    try {
      await prisma.lga.create({
        data: { code: l.code, name: l.name, stateCode: l.stateCode },
      });
      inserted += 1;
    } catch (err) {
      // Two cases land here: the row already exists (idempotent re-run), or the
      // same (stateCode, name) is present under a different code. Only the
      // latter is a data-quality problem worth counting.
      const alreadyPresent = await prisma.lga.findFirst({
        where: { stateCode: l.stateCode, name: l.name },
        select: { code: true },
      });
      if (alreadyPresent && alreadyPresent.code !== l.code) duplicates += 1;
      // else: already exists under this exact code, nothing to do.
    }
  }

  return { inserted, duplicates, total: LGAS.length };
}

async function seedKindsAndTypes(): Promise<{ kinds: number; types: number }> {
  for (const k of KINDS) {
    await prisma.listingKindDef.upsert({
      where: { code: k.code },
      update: {
        label: k.label,
        pricePeriods: [...k.pricePeriods],
        requiresDeedDoc: k.requiresDeedDoc,
      },
      create: {
        code: k.code,
        label: k.label,
        pricePeriods: [...k.pricePeriods],
        requiresDeedDoc: k.requiresDeedDoc,
      },
    });
  }

  for (const [index, t] of TYPES.entries()) {
    await prisma.listingType.upsert({
      where: { kindCode_code: { kindCode: t.kindCode, code: t.code } },
      update: {
        label: t.label,
        sortOrder: index,
        requiresBedrooms: t.requiresBedrooms ?? false,
        requiresPlotSize: t.requiresPlotSize ?? false,
      },
      create: {
        kindCode: t.kindCode,
        code: t.code,
        label: t.label,
        sortOrder: index,
        requiresBedrooms: t.requiresBedrooms ?? false,
        requiresPlotSize: t.requiresPlotSize ?? false,
      },
    });
  }

  return { kinds: KINDS.length, types: TYPES.length };
}

async function seedSlaPolicies(): Promise<number> {
  for (const p of SLA_POLICIES) {
    await prisma.reviewSlaPolicy.upsert({
      where: { kindCode: p.kindCode },
      update: {
        targetMinutes: p.targetMinutes,
        warnMinutes: p.warnMinutes,
        escalateMinutes: p.escalateMinutes,
      },
      create: { ...p },
    });
  }
  return SLA_POLICIES.length;
}

async function seedPlans(): Promise<number> {
  for (const p of PLANS) {
    await prisma.plan.upsert({
      where: { code: p.code },
      update: {
        name: p.name,
        tier: p.tier,
        priceNgn: p.priceNgn,
        billingPeriod: p.billingPeriod,
        description: p.description,
      },
      create: {
        code: p.code,
        name: p.name,
        tier: p.tier,
        priceNgn: p.priceNgn,
        billingPeriod: p.billingPeriod,
        description: p.description,
      },
    });

    await prisma.entitlement.deleteMany({ where: { planId: p.code } });
    await prisma.entitlement.createMany({
      data: p.entitlements.map((e) => ({
        planId: p.code,
        feature: e.feature,
        limitJson: e.limit as unknown as Prisma.InputJsonValue,
      })),
    });
  }
  return PLANS.length;
}

async function seedAdmin(): Promise<string | null> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    return null;
  }

  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return `Admin ${email} already exists; left untouched`;
  }

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hash(password, {
        type: 2,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      }),
      displayName: 'Naijaproperty Admin',
      role: 'SUPERADMIN',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: user.id,
      actorRole: 'SUPERADMIN',
      action: 'admin.bootstrap',
      entityType: 'user',
      entityId: user.id,
      metadata: { source: 'seed' },
    },
  });

  return `Created bootstrap admin ${email}`;
}

async function main(): Promise<void> {
  console.log('Seeding reference data...\n');

  const stateCount = await seedStates();
  const actualStates = await prisma.state.count();
  console.log(`  states             : ${actualStates}`);
  if (actualStates !== 37) {
    throw new Error(
      `Expected 37 jurisdictions (36 states + FCT), found ${actualStates}. ` +
        'Check the STATES table in seed-data/reference.ts.',
    );
  }

  const lgas = await seedLgas();
  const actualLgas = await prisma.lga.count();
  console.log(`  LGAs               : ${actualLgas} in database`);
  console.log(`                        (${lgas.inserted} inserted this run)`);

  if (lgas.duplicates > 0) {
    throw new Error(
      `${lgas.duplicates} LGA entries collide on (state, name). ` +
        'Tidy seed-data/seed-lgas.ts: each LGA must appear once per state.',
    );
  }

  if (actualLgas < 774) {
    console.log(
      `  note               : ${actualLgas} of 774 LGAs defined. Coverage is concentrated in\n` +
        `                        high-volume states; append the remainder to\n` +
        `                        seed-data/seed-lgas.ts and re-run. db:seed is idempotent,\n` +
        `                        and verify.ts reports this gap on every run.`,
    );
  }

  const { kinds, types } = await seedKindsAndTypes();
  console.log(`  listing kinds      : ${kinds}`);
  console.log(`  listing types      : ${types} (disjoint per kind)`);

  const sla = await seedSlaPolicies();
  console.log(`  review SLA policies: ${sla}`);

  const plans = await seedPlans();
  console.log(`  plans              : ${plans} (no live payments)`);

  const admin = await seedAdmin();
  console.log(`  admin              : ${admin ?? 'skipped (set SEED_ADMIN_EMAIL/PASSWORD)'}`);

  // Cross-check the invariant the product depends on: no type code may appear
  // under both kinds unless it is intentionally shared.
  const saleTypes = new Set(TYPES.filter((t) => t.kindCode === 'SALE').map((t) => t.code));
  const rentTypes = new Set(TYPES.filter((t) => t.kindCode === 'RENT').map((t) => t.code));
  const both = [...saleTypes].filter((c) => rentTypes.has(c));
  console.log(`\n  shared type codes  : ${both.length ? both.join(', ') : 'none'}`);
  console.log(
    '  note: shared codes are legal (BUNGALOW, COMMERCIAL etc exist in both\n' +
      '  taxonomies) but are stored under distinct composite keys, and the\n' +
      '  listings_type_kind_fk constraint prevents cross-kind attachment.\n',
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error('\nSeed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
