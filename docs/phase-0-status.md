# Phase 0 status

## What is running

| Component | State |
|---|---|
| Postgres 16 + PostGIS, Redis | Up in Docker (`infra/docker-compose.yml`) |
| API (NestJS + Fastify) | Compiled, migrated, boots clean, 13 routes mapped |
| Web (Next.js 15) | Serves on `:3100` (`:3000` was already taken by an unrelated `node dist-server/server.cjs`) |
| Schema + invariants | 2 migrations applied, 5 triggers / 5 functions / 8 partial indexes |
| Seed | 37 states, 326 LGAs, 27 types across 2 kinds, 2 SLA policies, 2 plans, 15 entitlements, bootstrap admin |
| Verification harness | 21 checks passing |

## Verified by execution, not assertion

`npm run prisma:verify` (in `apps/api/prisma/verify.ts`) proves the guarantees the product rests on:

- A RENT type **cannot** be attached to a SALE listing. Both the composite FK and the `BEFORE` trigger reject it.
- A SALE listing cannot declare `pricePeriod = NONE`; a RENT listing cannot omit it.
- A LAND listing cannot be created with `deedType = NONE`.
- A review cannot be inserted without a matching `contact_reveal` or `stay_record`.
- `audit_logs` rejects `UPDATE` and `DELETE`.
- PII envelope round-trips, contains no plaintext, and is tamper-evident (GCM auth tag).
- OTP codes never appear in their stored hash.
- Badge output never exceeds two, and trust badges outrank informational ones when the cap bites.

Live HTTP checks confirmed: register/login/`me` work; weak passwords and wrong passwords are rejected with 400; unsigned Termii webhooks are rejected with 401; OTP verification with no challenge returns `OTP_INVALID`; the OTP endpoint rate-limits after one request per minute per the configured throttle; all four Nigerian phone input formats (`08012345678`, `+234 801 234 5678`, `2348012345678`) normalise to the same E.164 form while a malformed number is rejected with field-level detail.

The web shell renders with the kind toggle switching the entire facet set, and the browser confirms the SALE view shows `Property type` where the RENT view shows `Rent period`.

## Deliberate deviations, and why

**No global `ValidationPipe`.** Every endpoint validates with the Zod schemas in `@naijaproperty/contracts`. A class-validator pipe would introduce a second, divergent rule set per DTO and make route shapes depend on decorator application. One schema, shared by API, web, and the future mobile app.

**No custom JSON content-type parser.** An earlier attempt registered one to capture raw bodies, which collided with Nest's own parser (`FST_ERR_CTP_ALREADY_PRESENT`). Nest's `rawBody: true` is a factory-level option and does the job without replacing the parser. The Termii signature check reads `request.rawBody`.

**Rate limiting is Postgres-backed, not Redis-backed.** `RateLimiterService` uses an atomic `INSERT ... ON CONFLICT DO UPDATE` so there is no read-then-write race, survives an API restart, and fails **closed** if the limiter itself errors. Redis is present for Phase 2 caching and WebSocket fan-out. The method surface is deliberately Redis-shaped so the swap is contained.

**`Turborepo` needed `packageManager` in `package.json`.** Without it, `turbo run` failed to resolve the workspace. The repo also carries an `AGENTS.md` rule that bundled `turbo` docs be read before changing turbo config; I read `docs/README.md` and confirmed the installed version's expectations before touching `package.json`.

## Bugs found and fixed during the build

- **`Kwara` was missing from the state list**, so the seed produced 36 rows, not 37. The seed now asserts the count and throws rather than proceeding.
- **`Oshodi-Isale`, `Obio-Akpor`, `Ikorodu`, `Surulere` were listed twice under Lagos** and `Kano` twice under Rivers. Rewritten to one row per (state, name).
- **All 70 `DateTime` columns were `timestamp without time zone`.** For a national site with a strict review SLA and a client in UTC+1, storing naive timestamps is a latent off-by-one-hour bug on every deadline. All are now `timestamptz`.
- **`pricePeriod`, `deedType`, `agencyFee`, and `status` were unmapped**, producing mixed-case column names while the SQL invariants assumed snake_case. Added `@map` and migrated.
- **The LGA seed reported `0 seeded` on a successful run**, because it counted `continue` on "already exists" as a skip. Rewritten to distinguish inserted / duplicate / already-present, and to throw on duplicate (state, name) pairs instead of hiding them.

## Known gaps, stated plainly

**LGA coverage is 326 of 774.** Seeded high-volume states first (Lagos, FCT, Ogun, Oyo, Rivers, Anambra, Kaduna, Delta, Kano, Enugu, Edo, Imo, Cross River, Akwa Ibom, Osun, Ondo, Kwara, Plateau, Abia). The seed and the verification harness both print the gap on every run, so it cannot be mistaken for complete. Completing it is data entry, not engineering.

**Phase 0 has no listing, media, search, reveal, or chat endpoints yet.** `RevealService`, `LocationsService`, `RateLimiterService`, the schema for listings/media/reviews, and the web listing card are written and typecheck, but are not wired into controllers. That is Phase 1 and Phase 3 work.

**Termii, SMTP, Google OAuth, R2, and Stream are unconfigured**, so OTP sends log `termii_not_configured` and challenges land in `FAILED`. This is correct fail-fast behaviour, and `/auth/otp/channels` reports `whatsapp: false` so the client would send SMS directly. The WhatsApp-first fallback path is therefore implemented and reasoned about but **not yet exercised against the live Termii API**.

**The OTP fallback cache is per-instance.** Plaintext codes and phone numbers live in an in-process map for the challenge lifetime, because only their HMAC is persisted. That is correct for the single API process of Phase 0 and is documented in `docs/otp-whatsapp-fallback.md`; scaling horizontally requires moving both to Redis with a matching TTL.

## Next

Phase 1: listing creation, the media pipeline with direct-to-R2 uploads, and the review queue with the 1–6 hour SLA. The SLA policies, review event tables, moderation signals, and assignment tables are already in the schema.
