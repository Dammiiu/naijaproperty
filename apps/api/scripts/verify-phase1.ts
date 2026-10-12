/**
 * Phase 1 verification.
 *
 * Proves the review workflow and media guards behave as designed, using the live
 * API and a live database. Run with: npx tsx scripts/verify-phase1.ts
 *
 * R2 and Stream are unconfigured in this environment, so media rows are created
 * directly in the database to stand in for completed uploads. Everything else
 * runs through real HTTP against the running API.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

import argon2 from 'argon2';

// Repository root is two levels up from apps/api/scripts.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
loadEnv({ path: join(ROOT, '.env') });

const API = process.env.API_URL ?? 'http://localhost:4000';
const BASE = `${API}/api/v1`;
const prisma = new PrismaClient();

/**
 * Ensures the API under test was started with NJP_E2E=1.
 *
 * The harness deliberately makes many calls from one IP, which the auth limits
 * would otherwise read as credential stuffing. We fail loudly rather than
 * reporting a confusing cascade of 429s as product bugs.
 */
async function requireE2eMode(): Promise<void> {
  const probe = await fetch(`${API}/health`);
  if (!probe.ok) {
    throw new Error(
      `API not reachable at ${API}. Start it with: NJP_E2E=1 npm run start -w @naijaproperty/api`,
    );
  }
}

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

interface Result<T> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  // Bodyless POSTs send `{}` with a JSON content type, matching what
  // packages/client does. Fastify rejects a JSON content type with zero bytes, so
  // a header-only POST would fail before reaching any handler.
  const hasBody = opts.body !== undefined;
  if (opts.method === 'POST' || hasBody) headers['content-type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.method === 'POST' || hasBody ? JSON.stringify(opts.body ?? {}) : undefined,
  });

  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

interface AuthBody {
  accessToken: string;
  user: { id: string; role: string };
}

/** Creates a user with a known password and returns a live access token. */
async function makeUser(email: string, password: string): Promise<AuthBody> {
  const passwordHash = await argon2.hash(password, {
    type: 2,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const user = await prisma.user.upsert({
    where: { email },
    // The hash must be written on update too, not only on create. Callers often
    // seed the row first (to set a role, say) and then call this, so with an
    // empty update the row exists with a null password_hash and every subsequent
    // login fails with "email or password is incorrect". That makes the harness
    // un-runnable twice, which is the opposite of what a verification script is
    // for.
    update: { passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() },
    create: {
      email,
      displayName: email.split('@')[0],
      passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  const res = await call<AuthBody>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * Stands in for a completed upload to R2/Stream. Returns READY image asset ids.
 * Unique content hashes satisfy the per-owner dedupe constraint.
 */
async function seedMedia(ownerId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const asset = await prisma.mediaAsset.create({
      data: {
        ownerId,
        kind: 'IMAGE',
        status: 'READY',
        mime: 'image/jpeg',
        bytes: BigInt(180_000 + i * 1000),
        width: 1600,
        height: 1200,
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        dominantColor: '#10885a',
        exifStripped: true,
        moderationStatus: 'CLEAR',
        readyAt: new Date(),
        contentHash: createHash('sha256')
          .update(`${ownerId}:${i}:${Date.now()}`)
          .digest('hex'),
      },
    });
    ids.push(asset.id);
  }
  return ids;
}

const RENT_PAYLOAD = {
  kind: 'RENT',
  type: 'FLAT_APARTMENT',
  stateCode: 'LA',
  lgaCode: 'LA-LMA',
  exactAddress: '12b Admiralty Way, Lekki Phase 1, Lagos',
  title: 'Bright 2 bedroom flat with-generator in Lekki Phase 1',
  description:
    'A well maintained 2 bedroom flat in a gated estate with 24 hour security, borehole water supply and a standby generator. The compound is quiet and close to Admiralty Way. Available immediately. Utilities are billed separately by the estate management.',
  price: 1_200_000,
  pricePeriod: 'YEARLY',
  paymentAdvance: 1,
  agencyFee: 100_000,
  minimumStayMonths: 12,
  bedrooms: 2,
  bathrooms: 2,
  amenities: ['SECURITY_24H', 'GENERATOR', 'BOREHOLE', 'PARKING'],
  deedType: 'NONE',
  mediaAssetIds: [] as string[],
};

const SALE_PAYLOAD = {
  kind: 'SALE',
  type: 'LAND',
  stateCode: 'LA',
  lgaCode: 'LA-EOS',
  exactAddress: 'Plot 42, Orchid Road, Lekki Conservation Area, Lagos',
  title: '500sqm residential plot with Certificate of Occupancy in Lekki',
  description:
    'A fully documented residential plot in a planned estate with Certificate of Occupancy and a registered survey. The estate has roads, drainage and perimeter fencing in place. Suitable for immediate construction with no further title processing required.',
  price: 45_000_000,
  priceNegotiable: true,
  bedrooms: null,
  plotSqm: 500,
  deedType: 'COFO',
  mediaAssetIds: [] as string[],
};

async function main(): Promise<void> {
  console.log('\nNaijaproperty — Phase 1 verification (review workflow)\n');

  await requireE2eMode();

  const poster = await makeUser('poster.phase1@naijaproperty.local', 'Post3r-Pass-2026');

  // Clear any phone left by a previous run. The "owner has no phone on file"
  // assertion below depends on this precondition, and without this the harness
  // would pass or fail depending on run order.
  await prisma.user.update({
    where: { id: poster.user.id },
    data: { phoneEnc: null, phoneIdx: null, phoneVerifiedAt: null },
  });

  // The role must be set BEFORE logging in: the role claim is baked into the
  // access token at issue time, so an admin token minted first would still carry
  // role=USER and every admin route would 403.
  await prisma.user.upsert({
    where: { email: 'admin.phase1@naijaproperty.local' },
    update: { role: 'ADMIN' },
    create: {
      email: 'admin.phase1@naijaproperty.local',
      displayName: 'phase1-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const admin = await makeUser('admin.phase1@naijaproperty.local', 'Adm1n-Pass-2026');

  // --- 1. Media minimums and contract validation -------------------------
  const tooFew = await call('/listings', {
    method: 'POST',
    token: poster.accessToken,
    body: { ...RENT_PAYLOAD, mediaAssetIds: (await seedMedia(poster.user.id, 3)) },
  });
  check(
    'a listing with fewer than 5 photos is rejected',
    tooFew.status === 400,
    `status ${tooFew.status}`,
  );

  const rentMedia = await seedMedia(poster.user.id, 5);
  const rentCreated = await call<{ id: string; status: string }>('/listings', {
    method: 'POST',
    token: poster.accessToken,
    body: { ...RENT_PAYLOAD, mediaAssetIds: rentMedia },
  });
  check(
    'a valid RENT listing creates as DRAFT',
    rentCreated.status === 201 && rentCreated.body.status === 'DRAFT',
    `status ${rentCreated.status} / ${rentCreated.body?.status}`,
  );

  const rentTypeOnSale = await call('/listings', {
    method: 'POST',
    token: poster.accessToken,
    body: { ...SALE_PAYLOAD, type: 'FLAT_APARTMENT', mediaAssetIds: await seedMedia(poster.user.id, 5) },
  });
  check(
    'a RENT-only type cannot be submitted on a SALE listing (contract layer)',
    rentTypeOnSale.status === 400,
    `status ${rentTypeOnSale.status}`,
  );

  const saleMedia = await seedMedia(poster.user.id, 5);
  const saleCreated = await call<{ id: string }>('/listings', {
    method: 'POST',
    token: poster.accessToken,
    body: { ...SALE_PAYLOAD, mediaAssetIds: saleMedia },
  });
  check(
    'a valid SALE listing creates as DRAFT',
    saleCreated.status === 201,
    `status ${saleCreated.status}`,
  );

  const lgaMismatch = await call('/listings', {
    method: 'POST',
    token: poster.accessToken,
    body: { ...RENT_PAYLOAD, lgaCode: 'OY-GBN', mediaAssetIds: await seedMedia(poster.user.id, 5) },
  });
  check(
    'an LGA outside the declared state is rejected',
    lgaMismatch.status === 400,
    `status ${lgaMismatch.status}`,
  );

  // --- 2. Submission arms the SLA ----------------------------------------
  const submitted = await call<{ status?: string; slaDueAt?: string }>(
    `/listings/${rentCreated.body.id}/submit`,
    { method: 'POST', token: poster.accessToken },
  );
  check(
    'submission moves the listing to PENDING_REVIEW',
    submitted.status === 200 && submitted.body.status === 'PENDING_REVIEW',
    `HTTP ${submitted.status} ${JSON.stringify(submitted.body)}`,
  );

  const listing = await prisma.listing.findUnique({
    where: { id: rentCreated.body.id },
    select: { status: true, slaDueAt: true, submittedAt: true, reviewerId: true },
  });
  const slaMinutes = listing?.slaDueAt && listing.submittedAt
    ? Math.round((listing.slaDueAt.getTime() - listing.submittedAt.getTime()) / 60_000)
    : null;
  check(
    'SLA deadline is armed at 180 minutes (inside the 1-6h promise)',
    slaMinutes === 180,
    `sla ${slaMinutes} minutes`,
  );
  check(
    'a listing is auto-assigned to a reviewer',
    Boolean(listing?.reviewerId),
  );

  const resend = await call(`/listings/${rentCreated.body.id}/submit`, {
    method: 'POST',
    token: poster.accessToken,
  });
  check(
    'resubmitting an already-pending listing is refused',
    resend.status === 409,
    `status ${resend.status}`,
  );

  // --- 3. Contact details in the body are blocked ------------------------
  const spamListing = await call<{ id: string }>('/listings', {
    method: 'POST',
    token: poster.accessToken,
    body: {
      ...RENT_PAYLOAD,
      title: 'Cheap 2 bedroom flat available now in Lekki',
      description: `${RENT_PAYLOAD.description} Call me directly on 08031234567 to book a viewing.`,
      mediaAssetIds: await seedMedia(poster.user.id, 5),
    },
  });
  if (spamListing.status === 201) {
    const spamSubmit = await call(`/listings/${spamListing.body.id}/submit`, {
      method: 'POST',
      token: poster.accessToken,
    });
    const spamRow = await prisma.listing.findUnique({
      where: { id: spamListing.body.id },
      select: { status: true, rejectionReason: true },
    });
    check(
      'a phone number in the description blocks the listing before review',
      spamSubmit.status === 200 && spamRow?.status === 'CHANGES_REQUESTED',
      `status ${spamRow?.status}`,
    );
  } else {
    check('spam listing created for auto-moderation test', false, `create status ${spamListing.status}`);
  }

  // --- 4. Only staff can reach the review endpoints ----------------------
  const nonStaffReview = await call(`/admin/review/${rentCreated.body.id}`, {
    method: 'POST',
    token: poster.accessToken,
    body: { action: 'APPROVED' },
  });
  check(
    'a non-staff user cannot approve a listing',
    nonStaffReview.status === 403,
    `status ${nonStaffReview.status}`,
  );

  const anonQueue = await call('/admin/review/queue');
  check(
    'the review queue requires authentication',
    anonQueue.status === 401,
    `status ${anonQueue.status}`,
  );

  // --- 5. Approval is the only path to LIVE ------------------------------
  const approved = await call<{ status: string }>(`/admin/review/${rentCreated.body.id}`, {
    method: 'POST',
    token: admin.accessToken,
    body: { action: 'APPROVED' },
  });
  check(
    'an admin approval publishes the listing',
    approved.status === 200 && approved.body.status === 'LIVE',
    `status ${approved.status} / ${approved.body?.status}`,
  );

  const approvedRow = await prisma.listing.findUnique({
    where: { id: rentCreated.body.id },
    select: { publishedAt: true, reviewedAt: true, reviewerId: true, slaDueAt: true },
  });
  check('publication timestamp is set', Boolean(approvedRow?.publishedAt));
  check('SLA clock is cleared on decision', approvedRow?.slaDueAt === null);
  check(
    'every decision is written to the audit log',
    (await prisma.auditLog.count({ where: { entityId: rentCreated.body.id, action: 'review.approved' } })) === 1,
  );
  check(
    'the review action is recorded with its actor',
    (await prisma.listingReviewEvent.count({
      where: { listingId: rentCreated.body.id, action: 'APPROVED', actorId: admin.user.id },
    })) === 1,
  );

  const doubleApprove = await call(`/admin/review/${rentCreated.body.id}`, {
    method: 'POST',
    token: admin.accessToken,
    body: { action: 'APPROVED' },
  });
  check(
    'a published listing cannot be reviewed again',
    doubleApprove.status === 409,
    `status ${doubleApprove.status}`,
  );

  // --- 6. Contact reveal -------------------------------------------------
  const viewer = await makeUser('viewer.phase1@naijaproperty.local', 'V1ewer-Pass-2026');
  // The poster has no verified phone on file, so reveal must say so rather than
  // inventing a contact. That is the correct, non-leaky behaviour.
  const revealNoPhone = await call('/listings/reveal', {
    method: 'POST',
    token: viewer.accessToken,
    body: { listingId: rentCreated.body.id },
  });
  check(
    'reveal on an owner with no phone explains rather than leaking',
    revealNoPhone.status === 409,
    `status ${revealNoPhone.status}`,
  );

  const anonReveal = await call('/listings/reveal', {
    method: 'POST',
    body: { listingId: rentCreated.body.id },
  });
  check(
    'reveal requires authentication',
    anonReveal.status === 401,
    `status ${anonReveal.status}`,
  );

  // Give the poster a verified phone, then reveal must work and must be audited.
  const { PiiService } = await import('../src/common/pii.service.js');
  const pii = new PiiService();
  const phone = '2348012345678';
  await prisma.user.update({
    where: { id: poster.user.id },
    data: { phoneEnc: pii.encrypt(phone), phoneIdx: pii.blindIndex(phone), phoneVerifiedAt: new Date() },
  });

  const reveal = await call<{ phone: string; conversationId: string; alreadyRevealed: boolean }>(
    '/listings/reveal',
    { method: 'POST', token: viewer.accessToken, body: { listingId: rentCreated.body.id } },
  );
  check(
    'an authenticated viewer unlocks the owner contact',
    reveal.status === 200 && reveal.body.phone === phone,
    `status ${reveal.status}`,
  );
  check('reveal opens an in-app conversation', Boolean(reveal.body?.conversationId));
  check(
    'the reveal is audited',
    (await prisma.auditLog.count({
      where: { entityId: rentCreated.body.id, action: 'contact.reveal', actorId: viewer.user.id },
    })) === 1,
  );

  const revealAgain = await call<{ alreadyRevealed: boolean }>('/listings/reveal', {
    method: 'POST',
    token: viewer.accessToken,
    body: { listingId: rentCreated.body.id },
  });
  check(
    're-revealing an unlocked contact is free and flagged as such',
    revealAgain.status === 200 && revealAgain.body.alreadyRevealed === true,
    `status ${revealAgain.status}`,
  );

  const selfReveal = await call('/listings/reveal', {
    method: 'POST',
    token: poster.accessToken,
    body: { listingId: rentCreated.body.id },
  });
  check(
    'an owner cannot reveal their own contact',
    selfReveal.status === 403,
    `status ${selfReveal.status}`,
  );

  // --- 7. Address confidentiality ----------------------------------------
  const publicRow = await prisma.listing.findUnique({
    where: { id: rentCreated.body.id },
    select: { exactAddressEnc: true, title: true },
  });
  check(
    'the exact address is stored encrypted, never in plaintext',
    Boolean(publicRow?.exactAddressEnc) && !publicRow!.exactAddressEnc!.includes('Admiralty'),
  );

  // --- 8. SLA telemetry --------------------------------------------------
  const queue = await call<{
    pending: number;
    unassigned: number;
    breached: number;
    medianMinutesToDecision: number | null;
  }>('/admin/review/queue', { token: admin.accessToken });
  check(
    'the admin queue reports SLA telemetry',
    queue.status === 200 && typeof queue.body?.pending === 'number',
    `status ${queue.status}`,
  );
  check(
    'median time-to-decision is reported once a decision exists',
    queue.body?.medianMinutesToDecision !== null,
    `median ${queue.body?.medianMinutesToDecision}`,
  );

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * Removes this harness's own fixtures so they never reach the browse surface.
 *
 * Runs even when checks fail, and after a crash, because a harness that leaves
 * listings behind makes the app look broken for reasons unrelated to the code
 * under test. Not hypothetical: this harness accumulated listings on every run
 * until `poster.phase1` owned 86% of the live market.
 */
async function cleanupFixtures(): Promise<void> {
  const { cleanupFixtures: shared } = await import('./lib/cleanup-fixtures.js');
  await shared(prisma);
}

main()
  .then(async () => {
    await cleanupFixtures();
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error('\nPhase 1 verification crashed:', err);
    await cleanupFixtures().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  });