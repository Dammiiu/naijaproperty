/**
 * Revoke Supabase Data API privileges on the application schema.
 *
 * Why this is needed
 * ------------------
 * Supabase ships two settings that are checked by default on a new project:
 * "Enable Data API" and "Automatically expose new tables". Together they
 * default-privilege every table in `public` to the `anon` and `authenticated`
 * roles, which PostgREST then serves to anyone holding the project's anon key.
 *
 * That anon key is designed to be public. It ships inside every browser
 * application. So on a fresh project, before this script runs, the entire schema
 * is world-readable, including:
 *
 *   - users.email and users.phone_enc
 *   - listings.exact_address_enc
 *   - contact_reveals (who unlocked whose contact, and when)
 *   - refresh_tokens
 *   - audit_logs
 *   - stay_records
 *
 * The envelope encryption on the PII columns protects nothing if the ciphertext
 * is downloadable by anyone on the internet.
 *
 * Naijaproperty connects to Postgres directly through Prisma and never imports
 * `supabase-js`. The Data API is not a feature here, it is only an exposure.
 *
 * Run once per project, after the first migration:
 *
 *   DATABASE_URL=postgresql://... npm run db:harden -w @naijaproperty/api
 *
 * Re-running is safe. Every statement is idempotent.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

/*
 * Resolve .env from the repository root rather than the working directory.
 *
 * `npm run --workspace` runs the script with cwd set to apps/api, so a bare
 * '.env' looks for apps/api/.env, which does not exist. The harness then fails
 * with "DATABASE_URL is required" while the variable is plainly set two levels
 * up. Resolving from import.meta.url makes this work from any directory.
 */
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });

const SCHEMA = 'public';
const ROLES = ['anon', 'authenticated'];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    for (const role of ROLES) {
      await prisma.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA ${SCHEMA} FROM ${role}`);
      await prisma.$executeRawUnsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} FROM ${role}`);
      await prisma.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} FROM ${role}`);
    }

    /*
     * Default privileges are the half that matters.
     *
     * Revoking on existing tables only protects today's schema. Supabase applies
     * the "expose new tables" behaviour as a schema-level default, so every
     * migration that creates a table silently re-arms the same hole unless the
     * default is revoked too. Without this block the fix lasts until the next
     * `migrate deploy`.
     */
    await prisma.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA} REVOKE ALL ON TABLES FROM ${ROLES.join(', ')}`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA} REVOKE ALL ON SEQUENCES FROM ${ROLES.join(', ')}`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA} REVOKE ALL ON FUNCTIONS FROM ${ROLES.join(', ')}`,
    );

    // Verify rather than assume. A REVOKE that silently matched nothing would
    // leave the report saying "hardened" over an exposed schema.
    const exposed = await prisma.$queryRawUnsafe<{ n: number }>(`
      select count(*)::int as n
      from information_schema.tables
      where table_schema = '${SCHEMA}'
        and (
          has_table_privilege('anon', format('%I.%I', table_schema, table_name), 'SELECT')
          or has_table_privilege('authenticated', format('%I.%I', table_schema, table_name), 'SELECT')
        )
    `);

    if (exposed[0].n > 0) {
      throw new Error(`${exposed[0].n} public table(s) are still readable by anon or authenticated`);
    }

    console.log('Hardened: anon and authenticated hold no privileges on the public schema.');
    console.log('Default privileges revoked, so future migrations will not re-expose tables.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Hardening failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});