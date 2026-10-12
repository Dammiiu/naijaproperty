# Deployment

Where each piece of Naijaproperty runs in production, and why it cannot all go
in one place.

The short version: **Cloudflare hosts the web app and the media. The API and the
database must run somewhere with a real Node runtime and a real Postgres.** This
is not a preference. It is enforced by the dependencies.

---

## The constraint that decides the shape

`apps/api` cannot run on Cloudflare Workers, and no amount of configuration
changes that:

| Dependency | Why it blocks Workers |
|---|---|
| `argon2` | Native Node addon (`.node` binary). Workers cannot load native modules. |
| `sharp` | Native Node addon. Used for image processing and placeholder rendering. |
| `@prisma/client` | Ships a platform-specific query engine binary; Workers has no writable filesystem. |
| `ioredis` | Needs a raw TCP socket. Workers only allow `fetch` to HTTP(S). |

Workers also cannot run Postgres at all. So the API needs a container host, and
the database needs a managed Postgres that supports the extensions below.

`apps/web` has **no** such blockers. It has no native dependencies, its
middleware is already Edge-safe (`atob`, no `Buffer`), and it does not use
`next/image`, so there is no `sharp` requirement and no image optimizer to run.

---

## Target topology

```
                    Cloudflare (DNS, WAF, CDN)
                             |
        +--------------------+--------------------+
        |                                         |
   Workers (web)                            api.example.com
   @opennextjs/cloudflare                        |
        |                                    Render (container)
        |                                         |
        +------------> api  <---------------------+
                    Supabase Postgres
```

| Piece | Host | Status |
|---|---|---|
| `apps/web` | Cloudflare Workers | Dockerfile/OpenNext config to add |
| `apps/api` | Render | **Done.** `apps/api/Dockerfile`, built and verified |
| Postgres | Supabase | Needs the 5 extensions enabled |
| Redis | Render Redis or Upstash | Needs `REDIS_URL` |
| Images | Cloudflare R2 | Already live |
| Video | Cloudflare Stream | Blocked on token scope, see below |

---

## Database: the extension requirement

This is the single most likely thing to break a deployment, so it is worth being
explicit.

`schema.prisma` declares:

```
extensions = [postgis, pg_trgm, citext, btree_gin, unaccent]
```

and there is a real spatial column:

```
geom  Unsupported("geometry(Polygon, 4326)")
```

Consequences:

- **Render's plain PostgreSQL cannot be used.** It has no PostGIS. The schema
  will not migrate.
- **Supabase works**, but PostGIS and the others must be enabled on the project
  before the first migration runs. Supabase has PostGIS available in its
  extension list; enable `postgis`, `pg_trgm`, `citext`, `btree_gin`,
  `unaccent`.
- **Neon works**, with the same caveat: extensions are per-branch and must be
  enabled before migrating.

Always enable extensions **before** the first `prisma migrate deploy`. A failed
migration leaves `_prisma_migrations` in a partial state and needs manual
recovery.

---

## API deployment (Render)

The image is `apps/api/Dockerfile`, built from the **repository root**:

```bash
docker build -f apps/api/Dockerfile -t njp-api .
```

### Render service settings

| Setting | Value |
|---|---|
| Root directory | leave blank (the Dockerfile path is set in the Dockerfile field) |
| Dockerfile path | `./apps/api/Dockerfile` |
| Runtime | Node 22 |
| Health check path | `/health` |

### Environment

Copy `.env.example` and set these. Everything else can stay unset until the
corresponding integration is ready, because `assertConfigured()` only hard-fails
in production for a feature you are actually turning on.

Required from first boot:

```
NODE_ENV=production
DATABASE_URL          # pooled connection string from Supabase
REDIS_URL
WEB_URL               # https://naijaproperty.ng
API_URL               # https://api.naijaproperty.ng
JWT_ACCESS_SECRET     # openssl rand -base64 48
JWT_REFRESH_SECRET    # openssl rand -base64 48
OTP_PEPPER            # openssl rand -base64 32
PII_ENCRYPTION_KEY    # 32 bytes hex
```

**`PII_ENCRYPTION_KEY` is not rotatable casually.** It envelope-encrypts every
phone number and address in the database. Generating a new one makes existing
rows undecryptable. Set it once, store it in Render's secret store, and do not
regenerate it.

### Migrations

Do **not** run migrations on container start. Two replicas booting together would
race, and two processes applying the same migration is a production outage.

Set Render's **Pre-deploy Command**:

```
npm run db:deploy
```

which runs `prisma migrate deploy`. This runs once, before traffic shifts.

`prisma/invariants.sql` is applied separately and is not part of migrate deploy.
Check `npm run prisma:invariants` before relying on it in production.

---

## Web deployment (Cloudflare Workers)

The web app needs `@opennextjs/cloudflare`. That is not installed yet. When it
is added:

- `apps/web/next.config.ts` needs the OpenNext wrapper.
- `INTERNAL_API_URL` is already read by `apps/web/src/middleware.ts`; set it to
  the API origin so the edge does not depend on `NEXT_PUBLIC_API_URL`.
- Node.js APIs are unavailable in the edge runtime. `middleware.ts` already
  avoids them. Audit server components before the first deploy: `Buffer`, `fs`,
  `node:crypto` and raw TCP will all fail.

**Recommendation: deploy the web app to a conventional Node host first**, confirm
the whole system works end to end, then move the web app to Workers. There is no
current production to preserve, but there is also no reason to take on the
OpenNext compatibility risk in the same week the database moves.

---

## Still blocked, unrelated to hosting

| Issue | State |
|---|---|
| Cloudflare Stream | Token has zero Stream scope (account read returns 200, all `/stream` endpoints return 403). Needs **Account → Stream → Edit**. |
| Stream webhook secret | `CLOUDFLARE_STREAM_WEBHOOK_SECRET` is a placeholder. The handler fails closed without it. |
| R2 CORS | Browser photo upload fails. `http://localhost:3000` is missing from AllowedOrigins; the rule was written when the dev server was on 3100. |
| Termii WhatsApp OTP | Sender ID unregistered. SMS fallback only. |
| Map view | No lat/lng on listings. Needs area/LGA centroid geocoding. |

R2 and Stream are already in the right account and the R2 bucket is live, so
these are credential fixes rather than architecture work.

---

## Local run

```bash
npm run infra:up          # postgres (postgis), shadow db, redis
npm run db:demo           # demo listings, reviews, reviewer accounts
npm run build
npm run start -w @naijaproperty/api
npm run start -w @naijaproperty/web
```

Servers: web `http://localhost:3000`, api `http://localhost:4000`.
