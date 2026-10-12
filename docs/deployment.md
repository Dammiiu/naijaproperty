# Deployment

Where each piece of Naijaproperty runs in production, and why it cannot all go
in one place.

**Chosen topology: Cloudflare (web, media, DNS) + Railway (API) + Supabase
(Postgres). Source of truth is GitHub, with all three platforms deploying from
it.**

The short version: **Cloudflare hosts the web app and the media. The API and the
database must run somewhere with a real Node runtime and a real Postgres.** This
is not a preference. It is enforced by the dependencies.

---

## What is already done

| Artefact | State |
|---|---|
| `apps/api/Dockerfile` | Written, built, and **verified running against a live database** (health 200, search returns correctly-rated listings) |
| `apps/web/Dockerfile` | Written, uses `output: 'standalone'`, not yet built |
| `.dockerignore` | Written. Fixes a real bug, see below |
| `docs/deployment.md` | This file |
| Git history | Initial commit, 218 files, verified free of secrets |

## The constraint that decides the shape

`apps/api` cannot run on Cloudflare Workers, and no amount of configuration
changes that:

| Dependency | Why it blocks Workers |
|---|---|
| `argon2` | Native Node addon (`.node` binary). Workers cannot load native modules. |
| `sharp` | Native Node addon. Used for image processing and placeholder rendering. |
| `@prisma/client` | Ships a platform-specific query engine binary; Workers has no writable filesystem. |
| `ioredis` | Needs a raw TCP socket. Workers only allow `fetch` to HTTP(S). |

Workers also cannot run Postgres at all.

`apps/web` has **no** such blockers. Verified:

- No native dependencies (only `next`, `react`, `hls.js` and workspace packages).
- `src/middleware.ts` is already Edge-safe: it uses `atob`, never `Buffer`, and
  already reads `INTERNAL_API_URL` so the edge is not tied to a public URL.
- **No `next/image` anywhere.** All ten image usages are plain `<img>` tags
  pointing directly at R2 or Stream URLs, so there is no image optimizer and no
  `sharp` requirement. The `images` block in `next.config.ts` is inert.

---

## Railway (API)

Railway builds from a Dockerfile. Because this is a monorepo and the Dockerfile
is not at the root, two settings are required or Railway will fail to build.

| Railway setting | Value |
|---|---|
| Root directory | *(leave blank)* |
| Dockerfile path | `apps/api/Dockerfile` |

If the Root Directory field is left blank and the Dockerfile path is set, Railway
builds from the repository root, which is what the Dockerfile expects. Setting a
root directory to `apps/api` would break it, because the build needs
`package-lock.json` and the sibling workspace packages.

### Environment variables

Required from first boot:

```
NODE_ENV=production
DATABASE_URL          # Supabase pooled connection string, see below
REDIS_URL             # Railway Redis, or Upstash
WEB_URL=https://naijaproperty.ng
API_URL=https://api.naijaproperty.ng

JWT_ACCESS_SECRET     # openssl rand -base64 48
JWT_REFRESH_SECRET    # openssl rand -base64 48
OTP_PEPPER            # openssl rand -base64 32
PII_ENCRYPTION_KEY    # 32 bytes, hex
```

Optional integrations. `assertConfigured()` only hard-fails in production for a
feature you are actually enabling, so leaving these unset does not stop boot:

```
R2_ACCOUNT_ID / R2_BUCKET / R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_PUBLIC_URL
CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_STREAM_TOKEN / CLOUDFLARE_STREAM_WEBHOOK_SECRET
TERMII_* / SMTP_* / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / TURNSTILE_SECRET_KEY
```

**`PII_ENCRYPTION_KEY` is not rotatable casually.** It envelope-encrypts every
phone number and address in the database. Generating a new one makes existing rows
undecryptable. Set it once, in Railway's secret store, and do not regenerate it.

### Migrations

Migrations must **not** run on container start. Two replicas booting together
would race, and two processes applying the same migration is a production outage.

Railway does not have a Render-style pre-deploy hook, so run migrations manually
against the production database, once, before pointing the service at traffic:

```
DATABASE_URL=<supabase pooled url> npm run db:deploy
```

That is `prisma migrate deploy`. Never `migrate dev` against production.

---

## Supabase (Postgres)

### The extension requirement

This is the most likely thing to break the deployment, so it is worth being
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

- **Any plain Postgres without PostGIS will fail to migrate.** This rules out
  Render's PostgreSQL and Railway's PostgreSQL plugin.
- **Supabase works**, but all five extensions must be enabled *before* the first
  migration. Supabase ships PostGIS as an option in
  `Database > Extensions`; enable `postgis`, `pg_trgm`, `citext`, `btree_gin` and
  `unaccent`.

A failed migration leaves `_prisma_migrations` in a partial state and needs manual
recovery, so enable extensions first and verify before migrating.

### Connection strings

Use the **pooled** string (port 6543, the "Connection pooler" in the dashboard),
not the direct one, once there is more than one API replica:

```
# pooled, for the running API
DATABASE_URL=postgresql://postgres.[ref]:[pw]@[ref].pooler.supabase.com:6543/postgres?schema=public&connection_limit=10

# direct, for migrations only
# ...:5432/postgres?schema=public
```

Pooled connections do not support prepared statements or interactive
transactions in every mode. If Prisma complains, use the transaction pooler
(6543 with `pgbouncer=true`) rather than session mode.

### Also needed from Supabase

- Redis. `apps/api` uses `ioredis`, which needs a TCP socket, so Supabase's
  built-in Redis is not a drop-in. Use Railway Redis or Upstash and set
  `REDIS_URL`.

---

## Cloudflare Workers (web)

The web app is Workers-compatible. It needs `@opennextjs/cloudflare`, which is
**not installed yet**. That is the remaining piece of work.

Recommended order, so a compatibility problem never reaches the real domain:

1. Deploy to the default `*.workers.dev` subdomain. No DNS involved, nothing
   customer-facing at stake.
2. Verify auth, listing detail, image loading, messaging and reviews against the
   production API.
3. Only then attach the custom domain.

Audit before the first deploy: the edge runtime has no `Buffer`, `fs`, `node:crypto`
or raw TCP. `middleware.ts` already complies. Server components need checking.

---

## GitHub

Source of truth for all three platforms. Deploy by pushing.

To push, you need either:

- GitHub CLI installed and authenticated, or
- a remote plus a Personal Access Token.

Neither is configured on this machine. `gh` is not installed and no remote is set.

Once pushed:

| Platform | Deploy trigger |
|---|---|
| Railway | Connect the GitHub repo; deploys on push to the default branch |
| Cloudflare Workers | Connect the GitHub repo in Workers Builds; builds on push |
| Supabase | Migrations are run manually, not on push |

---

## Still blocked, unrelated to hosting

| Issue | State |
|---|---|
| Cloudflare Stream | Token has zero Stream scope: account read returns 200, every `/stream` endpoint returns 403. Needs **Account -> Stream -> Edit**. |
| Stream webhook secret | `CLOUDFLARE_STREAM_WEBHOOK_SECRET` is a placeholder. The handler fails closed without it. |
| R2 CORS | Browser photo upload fails. `http://localhost:3000` is missing from AllowedOrigins; the rule was written when the dev server ran on 3100. Add it in R2 -> Settings -> CORS. |
| Termii WhatsApp OTP | Sender ID unregistered. SMS fallback only. |
| Map view | No lat/lng on listings. Needs area/LGA centroid geocoding. |
| Termii API key | Was pasted into chat and is in `.env`. Treat as exposed and rotate. |

R2 and Stream are already in the right account and the R2 bucket is live, so
these are credential fixes rather than architecture work.

---

## Two bugs found while preparing the deploy

Recorded because both produce confusing failures rather than honest errors.

**`--env-file` crashes on a missing file.** The API start script was
`node --env-file=../../.env dist/main.js`. On any platform that injects
environment variables rather than shipping a `.env` file, that exits 9 and the
service never boots. Changed to `--env-file-if-exists`, which keeps local
development identical and exits 0 when the file is absent.

**Stale `tsconfig.tsbuildinfo` silently emptied a build.** The repo had no
`.dockerignore`, so the host's `node_modules` (1.4 GB) was copied into the build
context and the Linux tar writer refused the Windows workspace symlinks. Adding
`.dockerignore` fixed the copy, but `tsc -b` still emitted nothing: Docker
matches ignore patterns against the path relative to the context root and a bare
`*` does not cross directory boundaries, so `*.tsbuildinfo` never matched
`packages/contracts/tsconfig.tsbuildinfo`. The build-info files were copied in,
`tsc -b` decided it was up to date, and the API then failed to resolve
`@naijaproperty/contracts`. The pattern is now `**/*.tsbuildinfo`.

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
Infra containers use `restart: unless-stopped`, so they survive a Docker or host
restart. The two app servers do not: they are foreground processes and die with
the shell that started them.