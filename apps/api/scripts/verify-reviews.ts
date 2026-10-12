/**
 * Reviews verification.
 *
 * Three separate bugs got through this surface before it had a harness, and all
 * three were invisible in the happy path:
 *
 *  1. `createReviewRequestSchema` required `listingId` in the body while the
 *     endpoint took the listing from the path, so a caller that followed the
 *     route shape exactly was rejected with "listingId: Required" and could never
 *     write a review.
 *  2. The list endpoint used `votes: viewerId ? {...} : false` in its Prisma
 *     select. `false` is not a valid select value; it omits the field entirely,
 *     so anonymous browsing hit `.filter` on undefined and 500'd for every
 *     signed-out visitor, which is most traffic.
 *  3. A non-live or unknown listing must 404 rather than leak that it exists.
 *
 *   npm run verify:reviews -w @naijaproperty/api
 */

import { config as loadEnv } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });

const prisma = new PrismaClient();

const BASE = 'http://localhost:4000/api/v1';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function call<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function main() {
  if (process.env.NJP_E2E !== '1') {
    console.error('Set NJP_E2E=1 before running. The harness creates real rows.');
    process.exit(1);
  }

  console.log('Reviews\n');

  const login = await call<{ accessToken: string; user: { id: string; email: string } }>(
    '/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ email: 'demo.ada@listers.ng', password: 'DemoPass!2026njp' }),
    },
  );
  if (login.status !== 200) {
    console.error('Could not sign in as the demo user. Is the API running?');
    process.exit(1);
  }
  const token = login.body.accessToken;
  const me = login.body.user;

  const search = await call<{ items: Array<{ id: string; title: string }> }>(
    '/search/listings?kind=RENT&limit=20',
    {},
    token,
  );

  /*
   * Pick a listing this author has not already reviewed, and clear any review it
   * left behind on a previous run.
   *
   * `Review` is unique on (listingId, authorId), so a leftover row from an
   * earlier run makes the create call return 409 and every later assertion
   * reports a failure that has nothing to do with the code. The harness clears
   * its own rows instead of asserting against a database it does not control.
   */
  await prisma.review.deleteMany({ where: { authorId: me.id } });

  const target = search.body.items.find((i) => i.id !== me.id);
  if (!target) {
    console.error('No candidate listing found.');
    process.exit(1);
  }

  console.log(`listing: ${target.title.slice(0, 50)}\n`);

  console.log('reading');
  {
    // Regression for bug 2: this must not 500 with no token.
    const anon = await call<{ items: unknown[]; totalCount: number }>(`/listings/${target.id}/reviews`);
    check(
      'an anonymous visitor can read reviews',
      anon.status === 200 && Array.isArray(anon.body.items),
      `status ${anon.status}`,
    );

    const authed = await call<{ items: unknown[] }>(`/listings/${target.id}/reviews`, {}, token);
    check(
      'a signed-in visitor can read reviews',
      authed.status === 200 && Array.isArray(authed.body.items),
      `status ${authed.status}`,
    );

    const unknown = await call(`/listings/cmzzzzzzzzzzzzzzzzzzzzzzzz/reviews`);
    check('an unknown listing is a 404, not a 500', unknown.status === 404, `status ${unknown.status}`);
  }

  console.log('\nwriting');
  {
    const body = {
      ratingOverall: 4,
      ratingCommunication: 4,
      ratingAccuracy: 5,
      ratingValue: 4,
      body: 'Harness review. The landlord responded quickly, the property matched the description, and viewing was arranged without any pressure to commit on the spot.',
      eligibility: 'REVEALED',
    };

    /*
     * Validation is asserted BEFORE the happy path.
     *
     * Ordering matters here: `Review` is unique on (listingId, authorId) and the
     * API checks for an existing review before validating the body, so once a
     * review exists every later POST is a 409. Running the malformed-input check
     * after the create tested the duplicate guard twice and never reached
     * validation.
     */
    const short = await call(
      `/listings/${target.id}/reviews`,
      { method: 'POST', body: JSON.stringify({ ...body, body: 'too short' }) },
      token,
    );
    check('a review under the minimum length is rejected', short.status === 400, `status ${short.status}`);

    const badRating = await call(
      `/listings/${target.id}/reviews`,
      { method: 'POST', body: JSON.stringify({ ...body, ratingOverall: 9 }) },
      token,
    );
    check('an out-of-range rating is rejected', badRating.status === 400, `status ${badRating.status}`);

    const noAuth = await call(`/listings/${target.id}/reviews`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    check('writing requires sign in', noAuth.status === 401, `status ${noAuth.status}`);

    // Regression for bug 1: no listingId in the body, because it is in the path.
    const created = await call<{ id?: string; error?: { message: string; details?: Array<{ path: string }> } }>(
      `/listings/${target.id}/reviews`,
      { method: 'POST', body: JSON.stringify(body) },
      token,
    );
    check(
      'a review can be written without repeating listingId in the body',
      created.status === 201,
      `status ${created.status} ${created.body.error?.message ?? ''}`,
    );

    if (created.status === 201) {
      const list = await call<{ items: Array<{ body: string; ratingOverall: number; authorDisplayName: string }> }>(
        `/listings/${target.id}/reviews`,
        {},
        token,
      );
      const found = list.body.items?.some((r) => r.body === body.body);
      check('the new review is readable back', Boolean(found), `total ${list.body.items?.length ?? 0}`);

      const dupe = await call(
        `/listings/${target.id}/reviews`,
        { method: 'POST', body: JSON.stringify(body) },
        token,
      );
      check(
        'the same author cannot review a listing twice',
        dupe.status === 409,
        `status ${dupe.status}`,
      );
    }
  }

  // Leave the browse surface as it was found.
  await prisma.review.deleteMany({ where: { authorId: me.id } });
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
