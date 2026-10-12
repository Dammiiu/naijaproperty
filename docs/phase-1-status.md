# Phase 1 status — listings, media pipeline, review queue

Phase 0 is complete (see `phase-0-status.md`). This document covers what Phase 1 added and what
verification proved about it.

## What now exists

| Area | Detail |
|---|---|
| Listing creation | `POST /listings` → DRAFT, validated by the shared Zod contract |
| Review submission | `POST /listings/:id/submit` → `PENDING_REVIEW`, SLA armed at 180 minutes |
| Review decisions | `POST /admin/review/:id` — approve, reject, request changes, escalate |
| SLA telemetry | Queue depth, unassigned count, breaches, median time-to-decision |
| Auto-moderation | Contact-in-body blocking, duplicate-media and price-outlier warnings |
| Reviewer assignment | Least-loaded, state-scoped (ABAC), recorded on the listing |
| Contact reveal | `POST /listings/reveal` — the only path that decrypts PII |
| Media presigning | R2 presigned PUT for images, Stream Direct Upload for video |
| Locations API | States, LGAs, alias-aware area autocomplete, kind-scoped listing types |

## Verification

Two harnesses, both executable against a live database and a live API.

`npm run prisma:verify` — **21 checks, all passing.** Schema-level invariants: kind coherence,
price-period rules, land deed requirement, review eligibility, audit immutability, PII
confidentiality, OTP hashing, badge cap.

`npm run verify:phase1` — **28 checks, all passing.** End-to-end behaviour over HTTP.

The Phase 1 harness proves the product's central promises:

- Fewer than 5 photos is rejected; a valid RENT and a valid SALE listing both create as DRAFT
- A RENT-only type cannot be submitted on a SALE listing (contract layer)
- An LGA outside the declared state is rejected — this stops listings poisoning SEO area pages
- Submission moves to `PENDING_REVIEW` and arms a **180-minute** deadline, inside the 1–6 hour promise
- A reviewer is auto-assigned
- A phone number in the description blocks the listing before a human sees it
- Non-staff cannot approve; the queue requires authentication
- Approval publishes the listing, sets `publishedAt`, clears the SLA, and writes both a review event and an audit log
- A published listing cannot be reviewed twice
- Reveal on an owner with no phone explains the situation rather than leaking anything
- Reveal opens an in-app conversation and is audited
- Re-revealing is free and flagged `alreadyRevealed`
- An owner cannot reveal their own contact
- The exact address is stored encrypted — ciphertext contains no plaintext

## Bugs found by running it

Seven, all caught by execution rather than review.

**Postgres `count` returns a JS BigInt.** `limit - total` then threw a `TypeError`, and the caller
reported *any* rejection from the limiter as a 429 — so a BigInt bug presented as "you have contacted
too many listings" with real counters sitting at 6 against a cap of 40. Fixed by converting the BigInt
before arithmetic, and by making `assertWithinLimits` distinguish a genuine budget breach (429) from
an unexpected fault (500). A server bug must never be disguised as rate limiting.

**`VIEWER_LISTING_CAP = 1` broke a legitimate flow.** A first reveal attempt that failed (owner had
no phone) consumed the budget, so the user's later successful attempt was rejected. The per-listing
counter was redundant anyway — `contact_reveal` already gives idempotency for free. Removed.

**`prisma generate` fails with EPERM while the API is running**, because the live process holds
`query_engine-windows.dll.node`. Since `build` chained `prisma generate && nest build`, the compile
never ran. Worse, my build check only tested `dist/main.js` for existence, which still passed. Three
fixes: `build` no longer runs `prisma generate` (a separate `build:full` does), and the check now
inspects the exit code.

**Role was read from the JWT, not the database.** A user promoted to ADMIN after signing in kept a
`role=USER` token and got 403 on every admin route. `verifyAccessToken` now re-reads status and role
from the database, which also means a suspension takes effect immediately rather than at token
expiry.

**`LocationModule` could not resolve `JwtAuthGuard`** because it did not import `AuthModule`.

**`Reflector` is exported from `@nestjs/core`, not `@nestjs/common`.**

**Manual `app.init()` to swap the JSON parser silently dropped the global prefix.** Calling `init()`
early made Nest re-resolve routes without `api/v1`. I reverted to the framework default and made the
client send `{}` on bodyless POSTs, documenting the constraint rather than fighting it.

## Two design decisions worth flagging

**`verifyAccessToken` hits the database on every authenticated request.** That is one indexed primary-key
lookup, and in exchange a suspended account loses access immediately and a role change applies without
requiring re-login. For a trust product, a stale authorisation claim is the worse failure. If this ever
shows up as a latency problem, the fix is a short-TTL role cache, not trusting the token.

**Rate limiting is Postgres-backed with atomic `INSERT ... ON CONFLICT`.** No read-then-write race, it
survives a restart, and it fails *closed*. Redis is present for Phase 2 caching and WebSocket fan-out;
the method surface is deliberately Redis-shaped so the swap is contained.

## Known gaps

**LGA coverage is 326 of 774.** Seeded high-volume states first. Reported on every seed and every
verification run.

**R2 and Stream are unconfigured**, so no real upload has been exercised end to end. The Phase 1
harness stands in READY media rows directly. The presign paths, content-type and byte-length
constraints, HEAD-based size verification, and per-owner dedupe are written and typecheck, but the
signed-URL round trip against live Cloudflare is untested. This needs your account credentials.

**Post-processing is not built.** EXIF stripping, blurhash generation, dominant-colour extraction,
ClamAV scanning, and NSFW moderation are specified in `MediaService` but there is no worker. A completed
upload currently sits at `PROCESSING` rather than becoming `READY`.

**No public search or browse endpoints yet.** `ListingCard` and the search contract exist and the web
filter bar renders, but `GET /listings/search` is not implemented. That is Phase 2.

**In-app chat is not built.** Reveal creates the conversation row and returns its id; the WebSocket
gateway and message endpoints are Phase 3.

## Running the verification

```bash
npm run infra:up
npm run db:migrate
npm run db:invariants        # triggers, functions, partial indexes
npm run db:seed

npm run build -w @naijaproperty/api
NJP_E2E=1 npm run start -w @naijaproperty/api

npm run prisma:verify -w @naijaproperty/api   # 21 schema checks
npm run verify:phase1 -w @naijaproperty/api   # 28 end-to-end checks
```

`NJP_E2E=1` is required for the Phase 1 harness. It disables throttling, because the harness makes many
calls from one IP and the auth limits otherwise (correctly) read that as abuse. The bypass lives in
`AppThrottlerGuard`, is gated on `NODE_ENV !== 'production'`, and `main.ts` refuses to boot if
`NJP_E2E=1` is combined with `NODE_ENV=production`.
