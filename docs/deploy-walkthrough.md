# Deployment walkthrough: Supabase to live

Ordered, with the reason each step comes where it does. Steps 1 to 4 you have
already done.

Legend: **you** = you do this in a browser or shell. **me** = I can run it if you
paste the connection string.

---

## Step 5 — Copy both connection strings

**you** · Supabase → Project Settings → **Database** → Connection string

You need two, because they are used for different jobs.

**Direct connection, port 5432** — migrations only.

```
postgresql://postgres.PROJECTREF:PASSWORD@aws-0-eu-central-2.pooler.supabase.com:5432/postgres?schema=public
```

**Session pooler, port 6543** — the running API on Railway.

```
postgresql://postgres.PROJECTREF:PASSWORD@aws-0-eu-central-2.pooler.supabase.com:6543/postgres?schema=public&pgbouncer=true&connection_limit=5
```

The region host fragment matches whichever region you chose (`eu-central-2` for
Zurich). Copy it from the dashboard rather than hand-editing it.

`pgbouncer=true` is required: without it Prisma uses prepared statements, which
the pooler cannot support.

`connection_limit=5` is the pool size per replica. Prisma's default is CPU count
x 2 + 1, which on a multi-core host can exceed Supabase's project ceiling. There
is no separate pool variable; this URL parameter is the only one.

**If you paste the direct string here, I will run steps 6 and 7 for you and check
the results.**

---

## Step 6 — Run the migration

**me** (if you paste the string) or **you**:

```powershell
$env:DATABASE_URL = "<the 5432 direct string>"
npm run db:deploy
```

`db:deploy` is `prisma migrate deploy`. Never `migrate dev` against production:
it prompts for input and wants a shadow database.

Expect eleven migrations to apply. If it fails, **stop** — do not re-run blindly.
A partial failure leaves `_prisma_migrations` needing manual repair, and the fix
depends on which step failed.

---

## Step 7 — Apply the invariants

```powershell
npm run db:invariants
```

**Not covered by step 6, and not optional.**

`apps/api/prisma/invariants.sql` holds the triggers and composite foreign keys
that enforce the rule the whole product rests on: a rent listing can never carry
a sale type. It is applied by hand precisely so it is reviewed and run once.

A database without it boots perfectly and behaves perfectly until someone posts a
`RENT` listing with a `SALE` type. Nothing errors at boot. You find out later,
from data you cannot explain.

Verify:

```sql
select tgname from pg_trigger where not tgisinternal order by tgname;
```

---

## Step 8 — Verify the schema landed

**you** · SQL editor. Run all three.

```sql
-- 1. extensions (should return 5)
select extname from pg_extension
where extname in ('postgis','pg_trgm','citext','btree_gin','unaccent')
order by extname;
```

```sql
-- 2. tables (expect roughly 40)
select count(*) from information_schema.tables where table_schema = 'public';
```

```sql
-- 3. the spatial column exists and is the right type
select column_name, udt_name from information_schema.columns
where table_name = 'listings' and column_name = 'geom';
```

---

## Step 9 — Create the production admin

Nothing goes live without this. Every listing sits in `PENDING_REVIEW` until a
human approves it, so with no admin the site publishes nothing, forever.

```powershell
$env:DATABASE_URL = "<5432 direct>"
$env:SEED_ADMIN_EMAIL = "you@yourdomain.ng"
$env:SEED_ADMIN_PASSWORD = "<at least 12 characters, generated>"
npm run prisma:seed
```

`prisma:seed` creates reference data plus, when `SEED_ADMIN_*` is set, a
`SUPERADMIN`. The password must be at least 12 characters or it throws.

Generate it rather than typing it:

```bash
openssl rand -base64 24
```

---

## Step 10 — Railway: the API

**you** · railway.app → New Project → Deploy from GitHub repo → `Dammiiu/naijaproperty`

### The two settings that break the build

| Setting | Value |
|---|---|
| **Root Directory** | **leave blank** |
| **Dockerfile path** | `apps/api/Dockerfile` |

Root Directory must be blank. The build needs `package-lock.json` and the sibling
workspace packages, so it cannot run from inside `apps/api`.

### Variables

```
NODE_ENV=production
DATABASE_URL=<the 6543 pooled string, with pgbouncer and connection_limit=5>
REDIS_URL=<from step 11>
WEB_URL=https://naijaproperty.ng
API_URL=https://api.naijaproperty.ng

JWT_ACCESS_SECRET=<openssl rand -base64 48>
JWT_REFRESH_SECRET=<openssl rand -base64 48>
OTP_PEPPER=<openssl rand -base64 32>
PII_ENCRYPTION_KEY=<openssl rand -hex 32>
```

> **`PII_ENCRYPTION_KEY` cannot be rotated.** It envelope-encrypts every phone
> number and exact address. A new value makes every existing row permanently
> unreadable, with no recovery path. Generate once, store in Railway's secret
> store, and back it up somewhere durable.

Optional, none of which block boot: `R2_*`, `CLOUDFLARE_*`, `TERMII_*`,
`SMTP_*`, `GOOGLE_CLIENT_*`, `TURNSTILE_SECRET_KEY`. The API only hard-fails in
production for an integration you have actually enabled.

### Redis

**you** · Railway → New → Database → Redis. Or Upstash.

Supabase's built-in Redis is HTTP-only and the API uses `ioredis`, which needs a
raw TCP socket. They are not interchangeable.

---

## Step 11 — Confirm the API is alive

Once Railway finishes the first build:

```bash
curl https://api.naijaproperty.ng/health
```

Expect `{"status":"ok",...}`. If it 502s, the container bound to localhost —
check that `HOST`/`PORT` handling and the Dockerfile `EXPOSE 4000` line up with
Railway's expectations.

Check the boot log for the integrations line:

```
Google OAuth: configured
Termii WhatsApp OTP: not configured (SMS fallback only)
SMTP: not configured
```

A line reading `Cannot boot in production: <x> is not configured` means you set
`NODE_ENV=production` with an integration half-configured.

---

## Step 12 — Google OAuth: add the production redirect URI

**you** · Google Cloud Console → your OAuth client → Authorised redirect URIs

Add, alongside the localhost one already there:

```
https://api.naijaproperty.ng/api/v1/auth/google/callback
```

Both must be present. Without the production one, sign-in works locally and fails
in production with `redirect_uri_mismatch`, which reads as "Google is broken".

Then add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to Railway and redeploy.

---

## Step 13 — Cloudflare: Workers, on a throwaway subdomain first

**you** · dash.cloudflare.com → Workers & Pages → Create → **Connect to Git**

The repo is at `github.com/Dammiiu/naijaproperty` and now contains
`apps/web/Dockerfile` and the OpenNext dependency.

Build variables — these are **build** variables, not runtime:

```
NEXT_PUBLIC_API_URL=https://api.naijaproperty.ng
NEXT_PUBLIC_WEB_URL=https://<workers>.workers.dev
```

> `NEXT_PUBLIC_*` values are inlined into the browser bundle at build time.
> Setting them only when the Worker runs has no effect on the JavaScript a
> visitor downloads. A Worker built without them silently talks to localhost.
> The Dockerfile now fails the build if they are missing, rather than shipping
> that.

Deploy to `*.workers.dev` first. Do not attach the real domain yet.

Click through before going further: sign in with Google, open a listing, load an
image, open messages, read the reviews summary. OpenNext is a compatibility shim
over Next.js 15; I have verified this app has no hard blockers for Workers, but I
have not yet seen it build on the adapter.

---

## Step 14 — R2 CORS (blocks every photo upload)

Still unfixed, and it fails silently in a way that wastes hours: the browser sends
the bytes, R2 discards the response, and the image appears to upload and then
vanish.

**you** · Cloudflare → R2 → `naijaproperty-media` → Settings → CORS

Add `http://localhost:3000` to AllowedOrigins. The rule was written when the dev
server ran on port 3100 and went stale when it moved.

When you attach the real domain, add `https://naijaproperty.ng` too.

---

## Step 15 — Attach the real domain

Only after step 13 passes. Cloudflare → Workers → your Worker → Settings →
Domains & Routes → Custom Domain.

Then point `api.naijaproperty.ng` at Railway (Custom Domains → add domain).

Update Railway's `WEB_URL` and `API_URL` to the real hostnames and redeploy, or
the Google OAuth redirect will send people to `localhost`.

---

## Order, and why it is this order

```
Supabase project  ->  extensions  ->  migrate  ->  invariants  ->  admin
      ->  Railway API  ->  /health responds  ->  Google redirect URI
      ->  Workers on workers.dev  ->  click through everything
      ->  R2 CORS  ->  attach real domain
```

Extensions precede the migration because Prisma creates them and a half-created
extension fails the migration. Invariants follow the migration because it is a
separate hand-run step. The admin exists before any traffic because unreviewed
listings are the whole design. The real domain is last because OpenNext is
unproven here and a Workers quirk should not surface on a live hostname.

---

## Still blocked, unrelated to the above

| Issue | State |
|---|---|
| Cloudflare Stream | Token has zero Stream scope: account read returns 200, every `/stream` endpoint returns 403. Needs **Account -> Stream -> Edit**. Video upload returns 403 until then. |
| Stream webhook secret | Placeholder. The handler fails closed without it. |
| R2 CORS | Step 14. |
| Termii WhatsApp OTP | Sender ID unregistered. SMS fallback only. |
| Supabase free tier | **Pauses after 7 days inactive.** Fine while building, not acceptable at launch. Budget for Pro. |
| Fastify advisories | 7 high-severity including an authentication bypass. Fix is a NestJS 11 to 12 major upgrade. Deliberately deferred; owed as planned work. |
| Map view | No lat/lng on listings. Needs centroid geocoding. |

## Rotating the credentials you pasted

The GitHub token and the Google client secret are both in this conversation.
Revoke and regenerate the GitHub token once we are done pushing. For future
pushes, run `git push` yourself and let Credential Manager handle auth — that
removes the need for a token entirely.