# Supabase setup, step by step

Everything from the "Create a new project" screen to a migrated, invariant-checked
database that Railway can point at.

Work through it in order. Step 3 is the one people skip and it is the one that
breaks the migration.

---

## Step 1 — The project creation screen

You are looking at this screen. Four of the five fields matter.

| Field | What to choose | Why |
|---|---|---|
| Organization | `Dammiiu's Org` | Fine. |
| **GitHub** | **Leave unconnected** | See the warning below. |
| Project name | `naijaproperty` (no space) | Cosmetic only. The connection string uses a generated ref like `abcdefghijklmnop`, not this text. A space is harmless but untidy. |
| Database password | Keep the generated one, **copy it now** | Click **Copy** before you leave the page. This is the `postgres` password. It is not recoverable from the dashboard later; you would have to reset it. |
| **Region** | **Keep `Europe`** | Counter-intuitive but correct, see below. |
| **Security: Enable Data API** | **UNCHECK** | This is the dangerous one. |
| **Security: Automatically expose new tables** | **UNCHECK** | Same reason, and Supabase's own UI warns you. |
| Enable automatic RLS | Leave unchecked | Correct as-is. |
| Postgres Type | **Postgres** (default) | Do **not** pick Postgres with OrioleDB. Prisma's PostGIS support and the `geometry` column are validated against vanilla Postgres. OrioleDB is beta. |

### Why keep Europe

Every page render, every search query and every message send crosses to the
database. That round trip is on the critical path for a user sitting in Lagos.

The naive assumption is that a non-European region must be closer. It is not, for
Nigeria. Rough great-circle distances from Lagos:

| Supabase region | Distance from Lagos |
|---|---|
| Europe (Frankfurt) | ~4,900 km |
| Mumbai | ~7,200 km |
| Singapore | ~11,000 km |

There is no African region. Frankfurt is the closest one Supabase offers, so
**Europe is the right pick**. Do not switch it hoping for a latency win.

### Why uncheck Data API and "expose new tables"

Naijaproperty talks to Postgres **directly** through Prisma, using the
connection string. It never uses `supabase-js`, and the repo contains no
Supabase client dependency at all.

So the Data API is not a feature for us, it is pure attack surface. With "expose
new tables" ticked, every table Prisma creates is automatically granted to the
`anon` and `authenticated` roles, readable through a public REST endpoint using
the project's anon key. That key ships to every browser.

What becomes publicly readable includes:

- `users` with `phone_enc` and `email`
- `listings` with `exact_address_enc`
- `contact_reveals` — who revealed whose contact, and when
- `refresh_tokens`
- `audit_logs`
- `stay_records`

The encryption in the PII columns protects nothing if the ciphertext is
publicly readable. Untick both. If you ever want the Data API back, enable it
deliberately with explicit grants.

### Why not connect GitHub

Supabase's GitHub integration expects migrations in a `supabase/migrations`
directory and applies them to a preview branch per pull request.

Ours are Prisma migrations in `apps/api/prisma/migrations`, applied by
`prisma migrate deploy`. Connecting the integration would give Supabase a
migration path that finds nothing, and creates a preview database that is not the
schema the app expects. Skip it.

---

## Step 2 — Wait for the project to provision

Usually 1–3 minutes. The dashboard shows a green "Ready" banner when done.

Free tier limits you should know about now, not later:

- **Projects pause after 7 days of inactivity.** A free project will stop
  serving. When that happens it resumes on the next request after a few minutes.
  This is survivable while you are building, and unacceptable once real users
  are on it. Budget for the Pro plan before launch.
- 500 MB database, 2 active projects.

---

## Step 3 — Enable the extensions (DO NOT SKIP)

Left sidebar → **Database** → **Extensions**.

Enable each of these five:

| Extension | Required because |
|---|---|
| `postgis` | The schema has a real `geometry(Polygon, 4326)` column (`listing.geom`) for map search and nearby-similar. |
| `pg_trgm` | Fuzzy text search on area and title matching. |
| `citext` | Case-insensitive email lookup during login and registration. |
| `btree_gin` | Backs the GiN indexes the search path uses. |
| `unaccent` | Strips accents so "Lekki" matches "Lekkí" in a search. |

`schema.prisma` declares exactly this list in `extensions = [...]`.

**Why order matters:** Prisma creates these during `migrate deploy`. If they are
not already enabled, the migration either fails partway or, worse, half-succeeds
and leaves `_prisma_migrations` in a state that needs manual repair. Enabling
them first means the migration is a no-op for extensions and only does real work.

Verify with the SQL editor:

```sql
select extname from pg_extension
where extname in ('postgis','pg_trgm','citext','btree_gin','unaccent')
order by extname;
```

Expect five rows.

---

## Step 4 — Copy both connection strings

**Project Settings → Database → Connection string.**

You need both, because they are used for different things.

**Session pooler (port 6543)** — for the running API. Copy it. Shape:

```
postgresql://postgres.PROJECTREF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

**Direct connection (port 5432)** — for migrations only. Shape:

```
postgresql://postgres.PROJECTREF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres
```

They look similar. The port is the difference: **5432 direct, 6543 pooled.**

### Connection string parameters

Append to the pooled string:

```
?schema=public&pgbouncer=true&connection_limit=5
```

- `pgbouncer=true` tells Prisma to use transaction mode, which is what the
  pooler expects. Without it, prepared statements conflict with pooling.
- `connection_limit=5` is deliberate. Supabase's pooler has a hard ceiling of
  client connections per project, and Prisma's default (CPU count x 2 + 1) can
  exceed it. Five per replica leaves room for the migration process and for
  Supabase's own internal connections.

Do **not** append `connection_limit` to the direct string used for migrations.
Migration tooling manages its own connections there.

---

## Step 5 — Run the migration

From your machine, with the **direct** string:

```powershell
$env:DATABASE_URL = "postgresql://postgres.PROJECTREF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres?schema=public"
npm run db:deploy
```

`db:deploy` is `prisma migrate deploy`. Never `prisma migrate dev` against
production, it can prompt for input and will try to create a shadow database.

### Step 6 — Apply the invariants

```powershell
npm run db:invariants
```

**This is not optional and it is not covered by `migrate deploy`.**

`apps/api/prisma/invariants.sql` holds the kind-partition triggers, the composite
foreign keys and the unique indexes that enforce the core rule of this product: a
rent listing can never carry a sale type.

A database migrated without this step boots perfectly and behaves perfectly
until someone posts a `RENT` listing with a `SALE` type. Nothing errors at boot;
the corruption just appears later as data nobody can explain.

Verify it worked:

```sql
select tgname from pg_trigger where not tgisinternal order by tgname;
```

You should see several triggers, including ones enforcing the kind partition.

---

## Step 7 — Confirm the schema is real

```sql
select count(*) as tables from information_schema.tables
where table_schema = 'public';

select count(*) as listings from listings;
```

Zero listings is correct for a fresh production database. Do **not** run
`npm run db:demo` against production. It creates demo accounts with a published
password, and real traffic would sign in as them.

---

## Step 8 — Give Railway the pooled string

Railway service → **Variables**:

```
DATABASE_URL = (the 6543 pooled string from step 4)
REDIS_URL    = (Railway Redis, or Upstash)
NODE_ENV     = production
WEB_URL      = https://naijaproperty.ng
API_URL      = https://api.naijaproperty.ng

JWT_ACCESS_SECRET  = <openssl rand -base64 48>
JWT_REFRESH_SECRET = <openssl rand -base64 48>
OTP_PEPPER         = <openssl rand -base64 32>
PII_ENCRYPTION_KEY = <32 bytes hex>
```

Generate the four secrets:

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET, JWT_REFRESH_SECRET
openssl rand -base64 32   # OTP_PEPPER
openssl rand -hex 32      # PII_ENCRYPTION_KEY
```

> **`PII_ENCRYPTION_KEY` is not rotatable.** It envelope-encrypts every phone
> number and exact address. Generating a new one makes every existing row
> permanently unreadable, and there is no recovery path. Set it once, keep it in
> Railway's secret store, and back it up somewhere you will not lose.

### Supabase's own Redis is not a drop-in

The API uses `ioredis`, which needs a raw TCP socket. Supabase's Redis is
accessed over HTTP. They are not interchangeable. Use Railway Redis or Upstash.

---

## Checklist before you wire Railway up

- [ ] Project created, Data API **off**, "expose new tables" **off**
- [ ] Region left as Europe
- [ ] PostGIS, pg_trgm, citext, btree_gin, unaccent all enabled
- [ ] Five rows returned by the `pg_extension` query
- [ ] `prisma migrate deploy` completed
- [ ] `npm run db:invariants` completed
- [ ] `pg_trigger` returns the kind-partition triggers
- [ ] `listings` is empty (demo seed NOT run in production)
- [ ] Both connection strings saved, 5432 for migrations, 6543 for the app
- [ ] Railway has the pooled string, and four generated secrets