# Phase 2 status — public search, media processing, Termii integration

## What was added since Phase 1

| Area | Detail |
|---|---|
| Public search | `GET /search/listings`, `GET /search/areas` |
| Media post-processing | Worker: EXIF extraction and strip, dimensions, blurhash, dominant colour, stuck-asset reaper |
| On-demand processing | `POST /media/images/process` for posters waiting on upload completion |
| Termii wired up | Live credentials, v4 base URL, actionable sender-ID diagnostics |

## Verification

| Harness | Checks | Result |
|---|---|---|
| `npm run prisma:verify` | 21 | all passing |
| `npm run test:media` | 19 | all passing |
| `npm run verify:phase1 -w @naijaproperty/api` | 28 | all passing |
| `npm run verify:phase2 -w @naijaproperty/api` | 43 | all passing |

**111 checks total.** `npm run verify` runs the first two (no API required); `npm run verify:e2e`
runs the last two (needs `NJP_E2E=1 npm run start`).

### The partition, proven over HTTP

The single most important assertions in Phase 2, because they test the defect the incumbent actually
ships:

- A RENT search returns **zero** sale listings, and a SALE search returns **zero** rent listings
- The two result sets do not overlap
- `GET /search/listings` with no `kind` returns 400 — the partition is not optional
- RENT facets expose a payment-period group; SALE facets **do not**, because a sale listing has no
  payment schedule and showing one would mislead
- RENT facet types include `SELF_CONTAIN_1`, absent from SALE; SALE includes `LAND`, absent from RENT
- A `pricePeriod` filter applied to a SALE search cannot leak a rent listing

### Confidentiality, proven against a real payload

The harness seeds listings with the deliberately recognisable string
`sealed::99 … Admiralty Way, Lekki Phase 1, Lagos, Nigeria`, then asserts the serialised public
response contains none of: the address, the ciphertext, any 10+ digit Nigerian phone number, a storage
key, or the poster's user id.

This is enforced structurally rather than by discipline: `PUBLIC_SELECT` in `SearchService` is an
explicit column list that omits `exactAddressEnc`, so a future query edit cannot leak it.

### Facet counts agree with results

Each facet is counted with its own sibling predicates removed, otherwise selecting one type would zero
out every other type's count. Verified by asserting the type facet sums to the result total. This is
the difference between a filter panel people trust and one they learn to ignore.

### Other proven behaviour

Numeric price filters including off-ladder values like ₦7,500,000; inverted ranges rejected rather
than silently empty; rent-period filtering; bedroom, amenity, and trust filters; free-text search;
**informal alias resolution** — `q=Ikeja GRA` finds listings through `area_alias`; cursor pagination
producing disjoint pages; a malformed cursor restarting from page one instead of erroring; a listing
demoted to review disappearing from search immediately; an expired listing filtered out.

### Badge discipline

No card exceeds two badges, only the closed vocabulary appears, and no promotional label
(`MUST SEE`, `Sponsored`, `ONLY ON`) appears anywhere in the payload.

One deliberate behaviour worth stating: filtering `hasVideo=true` returns title-verified listings
whose badges are `[VERIFIED_TITLE, VERIFIED_OWNER]` — `HAS_VIDEO` is cut by the two-badge cap, because
trust claims outrank informational ones. The video signal is not lost; it rides on `videoCount`,
which the card renders as its own marker. The harness asserts the reverse invariant, which is the one
that matters: **never claim video without having it.**

## Bugs found and fixed

### Found by the media primitive tests (`npm run test:media`)

**The EXIF GPS reader would have failed on every real photograph.** The GPS IFD pointer (tag `0x8825`)
is TIFF type LONG, which always fits in the 4-byte inline value field. My parser treated `entry + 8`
— the *address* of that field — as the sub-IFD offset, instead of reading the 32-bit value stored
there. Every lookup landed on the wrong bytes and returned null. This is the kind of defect that
produces no error, no warning, and simply silently never geotags anything.

**TIFF type 2 (ASCII) was missing from the type-size table.** `GPSLatitudeRef` and `GPSLongitudeRef`
are ASCII. Without them the parser treated a two-character reference as out-of-line, read a garbage
offset, and returned null.

**The blurhash encoder was wrong twice.** It packed the DC term into `rgb` with a stride of 1 instead
of 3, which packs all the reds first and yields a uniform grey hash for every image. And it emitted
least-significant-digit-first while the decoder reads most-significant-first, so the two were not
inverses at all. A flat image now decodes back to its exact colour, asserted in the test.

These three were found by writing a hand-built EXIF fixture and a flat-colour image and checking the
round trip — cheap to test, and it caught defects that no amount of reading had.

### Found by the Phase 2 harness

**Query parameters arrive as strings, not arrays.** `type`, `pricePeriod`, `stateCode` and friends
were declared as `z.array(...)`, so `?pricePeriod=TWO_YEARLY` was rejected outright. Every multi-select
filter was broken for any normal client. Added a `queryList` preprocessor that accepts either a
repeated parameter or a single value, and drops empties so `?type=` behaves as absent.

**`listing.videoAssetId` is a real foreign key**, which is correct — it is what prevents a "Video tour"
badge on a listing that has none. The harness initially tried to fake it with a placeholder id and
hit the constraint. That is the schema doing its job; the test was fixed to create real video rows.

**`FacetBucket` was a Zod schema but not exported as a type**, so the API could not type its own facet
response.

**`await` inside a synchronous `without()` closure.** Facet clause filtering needed to be async to
rebuild the where clause.

### Two test expectations that were wrong, not the code

- **A `hasVideo=true` result does not necessarily carry a `HAS_VIDEO` badge.** Trust badges outrank
  informational ones under the two-badge cap, so a title-verified listing with video shows
  `[VERIFIED_TITLE, VERIFIED_OWNER]`. The video signal rides on `videoCount`. The assertion was
  rewritten to the inverse — never claim video without having it — which is the invariant that matters.
- **S/W EXIF references cannot be observed.** Nigeria lies entirely in the N/E quadrant, so the
  bounds check rejects every S/W coordinate before the sign logic runs. The test now asserts that
  honest behaviour rather than inventing an out-of-range point and pretending the sign survived it.

## Termii: live findings

Verified against your `Naija property` account.

- **Base URL confirmed.** Your dashboard reports `https://v4.api.termii.com`. The older
  `https://api.termii.com` also answers with identical results, but we configure v4 per your dashboard.
- **Credentials confirmed.** Balance endpoint returns `₦30.0000 NGN`. Auth works.
- **SMS sender ID is not registered.** A real send returns:
  ```
  HTTP 422  SENDER_ID_NOT_APPROVED: sender ID 'Naijaproperty' is not registered for
  workspace 01a113f8-f57e-7bf5-83a8-cb4eed6ef05b
  ```
  This proves the key, base URL, and payload shape are all correct — the request reached business logic
  and failed only on the sender. **You need to register an alphanumeric sender ID (3–11 chars) in the
  Termii dashboard and set `TERMII_SMS_FROM` to match it.** `TermiiService` now detects this specific
  error and logs an actionable message.
- **WhatsApp OTP reports `whatsapp: false`, correctly.** `channel=whatsapp_otp` must be enabled with
  Termii support and `TERMII_WHATSAPP_FROM` must be a connected device name. Until both are set the
  client sends SMS directly rather than arming a fallback timer that would never fire. Degraded
  behaviour, not a bug.

Full details and a zero-cost credential check are in `docs/otp-whatsapp-fallback.md`.

## Still not done

- **LGA coverage is 326 of 774.** This remains the largest data gap.
- **R2 and Stream are unconfigured**, so the media worker's Sharp pipeline, EXIF stripping, and
  blurhash encoding are written and typecheck but have never run against real object storage. The blurhash
  encoder and EXIF GPS reader are dependency-free by design and unit-testable without R2.
- **ClamAV and NSFW moderation are not wired.** The worker's failure policy and quarantine statuses
  exist; the scanners do not.
- **No map view.** PostGIS polygons are on `area` and `map_lat`/`map_lng` on listings, but there is no
  map endpoint or frontend.
- **No saved searches** despite `saved_search` and `saved_search_match` being in the schema.
- **In-app chat is not built.** Reveal creates the conversation row; there is no WebSocket gateway.
- **No listing detail page or admin review UI.** The web app still renders the Phase 0 shell with
  skeleton cards and does not call the search endpoint.
