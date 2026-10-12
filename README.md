# Naijaproperty

National property marketplace for Nigeria. Users post property for rent or sale with photos and a
walkthrough video; every listing is reviewed by an admin before it goes live. Anyone can browse, and
only signed-in users can reveal an owner's contact or message them.

## Why this exists

A browser teardown of the current Nigerian market found concrete, exploitable gaps:

- **Rent and sale are not separated.** PropertyPro renders an identical 17-item `Type` facet list on
  both its Sale and Rent pages, so "Self Contain" appears as a sale type and "Lands" appears as a rent
  type. Here `kind` is a schema-enforced partition (`listings_type_kind_fk` plus a `BEFORE` trigger),
  so a rent listing physically cannot appear in sale results.
- **Contact is fully exposed pre-login.** Call and WhatsApp buttons sit directly on the search cards.
  Here the phone number and exact address are envelope-encrypted, the public surface shows area/LGA
  only, and reveal is a single audited, rate-limited endpoint.
- **Nobody verifies property titles**, which is the primary scam vector. Here `deedType` is required
  for land, title documents are uploaded and reviewed, and `VERIFIED_TITLE` is one of only four
  badges we ever display.
- **Badges are worthless.** Cards stack `MUST SEE`, `Sponsored`, `Premium Gold`, `RECOMMENDED`,
  `ONLY ON PROPERTYPRO`, and more at once. We cap badges at two, and every one is a verifiable claim.
- **Price filters are unusable.** A fixed ladder (`50,000`, `100,000`, `200,000` … `1million`,
  `2million`, `3million`) cannot express a N7.5M budget. We use numeric range inputs with log-scaled
  suggestions spanning N50k to N2bn.
- **Rent is force-normalised to `/year`**, discarding the pay-2-years-upfront convention. We show the
  period the poster stated.

## Architecture

Real API boundary. The web app never touches Postgres, which is what makes the future mobile app and
partner integrations possible without a rewrite.

```
apps/
  api/    NestJS + Fastify. Sole owner of the database and all business rules.
  web/    Next.js 15 App Router. SSR public surface for SEO.
packages/
  contracts/  Zod schemas -> OpenAPI. Single source of truth for every payload.
  client/     Typed SDK over the contracts. Web and mobile consume identically.
  ui/         Design tokens and listing-presentation helpers.
  config/     Shared tsconfig.
infra/
  docker-compose.yml   Postgres + PostGIS, Redis, Typesense (optional profile)
```

### Media

Photos go to Cloudflare R2 via presigned `PUT`; video goes to Cloudflare Stream via Direct Creator
Upload (tus, resumable). **Media bytes never pass through the application server.** Bytes never
transcode on our instances, and R2 has no egress fee, which matters when serving Nigerian traffic.
Uploaded files are EXIF-stripped after GPS extraction so a poster's home coordinates are not
published.

### Phone OTP

Termii, WhatsApp-first. The WhatsApp OTP is sent first, a fallback timer is armed, and an SMS is only
spent when Termii's delivery webhook does not report `Delivered` inside that window. Delivery
reports are verified against the `X-Termii-Signature` HMAC-SHA512 of the **raw** body and applied
idempotently via a webhook inbox table.

### Security

- Argon2id passwords, rotating refresh tokens in httpOnly cookies, progressive login lockout.
- Constant-time response shaping so login cannot enumerate registered emails.
- PII envelope-encrypted (AES-256-GCM) with HMAC blind indexes for lookup without decryption.
- A CI-grade test asserts no phone number or exact address appears in any public serializer.
- Append-only `audit_logs`, enforced by a trigger that rejects `UPDATE` and `DELETE`.

## Getting started

```bash
npm install
cp .env.example .env          # then fill in the required secrets
npm run infra:up              # Postgres + PostGIS, Redis
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Web runs on `http://localhost:3000`, API on `http://localhost:4000`.

Required environment variables are validated at boot; the process refuses to start rather than
failing confusingly at request time. Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Verify the invariants

```bash
npm run db:seed
npx tsx prisma/verify.ts --workspace @naijaproperty/api
```

The harness asserts the guarantees the product depends on, including that a rent type cannot be
attached to a sale listing, that land must declare a deed type, that unverified reviews cannot be
inserted, and that `audit_logs` is immutable.

## Roadmap

| Phase | Scope |
| --- | --- |
| 0 | Repo, infra, schema, design tokens, auth (email, Google, phone OTP), RBAC, admin shell |
| 1 | Listing creation, media pipeline, review queue with 1–6h SLA |
| 2 | Discovery: facets, numeric price range, maps, area autocomplete, saved searches |
| 3 | Contact reveal and real-time in-app chat |
| 4 | Trust layer: title verification, review eligibility, badges, agency profiles |
| 5 | Agent dashboard, analytics, WhatsApp notifications, monetisation with a no-op provider |
| 6 | Expo mobile app on the same contracts |

## Design constraints worth preserving

- **Nigerian mobile data is expensive.** `navigator.connection.saveData` enables a data-saver mode
  that caps image quality and defaults video to 480p. Never autoplay video on mobile.
- **Phone is the identity primitive.** It underpins the `VERIFIED` badge and WhatsApp alerts.
- **Bounded badge economy.** Two per card, closed vocabulary, no promotional labels.
