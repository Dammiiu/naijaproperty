/**
 * Applies the database-level invariants.
 *
 * Prisma migrations describe shape; they cannot express CHECK constraints,
 * triggers, or partial indexes that this project depends on for correctness.
 * These live in `invariants.sql` and are applied here, after `prisma migrate`.
 *
 * The script is idempotent: every object is created IF NOT EXISTS / OR REPLACE,
 * so re-running is safe and can be wired into CI to prove the production
 * database has not drifted.
 *
 * Note on ordering: `rate_limit_counters` is created here rather than in the
 * Prisma schema because it is a pure infrastructure table with no model
 * attached. RateLimiterService writes to it via raw SQL.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Prisma's CLI loads .env automatically; tsx does not, so seed and verification
// scripts load it explicitly from the workspace root.
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });

const prisma = new PrismaClient();

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const sql = readFileSync(join(here, 'invariants.sql'), 'utf8');

  // Split on statement terminators at top level. The file contains no
  // dollar-quoted bodies with internal semicolons outside of $$ ... $$, which
  // is why PL/pgSQL functions here are written with $$ delimiters.
  const statements = splitStatements(sql);

  console.log(`Applying ${statements.length} invariant statements...\n`);

  for (const [index, statement] of statements.entries()) {
    const label = statement.slice(0, 60).replace(/\s+/g, ' ');
    try {
      await prisma.$executeRawUnsafe(statement);
      console.log(`  ${String(index + 1).padStart(2)}/${statements.length}  ${label}...`);
    } catch (err) {
      console.error(`\n  FAILED at statement ${index + 1}: ${label}...`);
      console.error(`  ${(err as Error).message}\n`);
      throw err;
    }
  }

  console.log('\nInvariants applied. Verifying...\n');
  await report();
}

/**
 * Splits a SQL script into executable statements.
 *
 * Correctly ignores semicolons inside string literals, quoted identifiers, and
 * dollar-quoted function bodies. A naive split on ';' would corrupt every
 * PL/pgSQL function in this file.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    const ch = sql[i] as string;

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      buf += ch;
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (two === '*/') {
        inBlockComment = false;
        buf += two;
        i += 2;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble && two === '--') {
      inLineComment = true;
      buf += two;
      i += 2;
      continue;
    }

    if (!inSingle && !inDouble && two === '/*') {
      inBlockComment = true;
      buf += two;
      i += 2;
      continue;
    }

    if (!inDouble && ch === "'") {
      // '' inside a literal is an escaped quote, not a terminator.
      if (inSingle && sql[i + 1] === "'") {
        buf += two;
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      buf += ch;
      i += 1;
      continue;
    }

    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      buf += ch;
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble && ch === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (ch === ';' && !inSingle && !inDouble && !dollarTag) {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  const tail = buf.trim();
  if (tail) out.push(tail);

  return out;
}

/** Reports which invariant objects exist, so drift is visible. */
async function report(): Promise<void> {
  const triggerRows = await prisma.$queryRaw<Array<{ tgname: string }>>`
    SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname
  `;
  const funcRows = await prisma.$queryRaw<Array<{ proname: string }>>`
    SELECT proname FROM pg_proc WHERE proname LIKE 'njp_%' ORDER BY proname
  `;
  const idxRows = await prisma.$queryRaw<Array<{ tablename: string; indexname: string }>>`
    SELECT tablename, indexname FROM pg_indexes
    WHERE indexname LIKE 'idx_%' ORDER BY tablename, indexname
  `;

  console.log(`  triggers   : ${triggerRows.length}`);
  for (const t of triggerRows) console.log(`              - ${t.tgname}`);

  console.log(`  functions  : ${funcRows.length}`);
  for (const f of funcRows) console.log(`              - ${f.proname}()`);

  console.log(`  indexes    : ${idxRows.length}`);
  for (const idx of idxRows) console.log(`              - ${idx.indexname}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error('\nFailed to apply invariants:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
