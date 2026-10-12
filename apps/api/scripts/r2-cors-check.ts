/**
 * Checks whether the R2 bucket CORS rule is actually live.
 *
 * Sends the preflight the browser really sends and reports whether the
 * `Access-Control-Allow-Origin` header came back. Deliberately a preflight rather
 * than a PUT, because a PUT succeeding proves nothing: the same-origin policy
 * does not apply to non-browser clients, so a server-side upload returns 200
 * against a bucket with no CORS rule at all while the browser fails every time.
 * That mismatch is what made this hard to diagnose.
 *
 *   npm run r2:cors:check -w @naijaproperty/api
 */

import { config as loadEnv } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });

const ENDPOINT = (process.env.R2_ENDPOINT ?? '').replace(/\/+$/, '');
const BUCKET = process.env.R2_BUCKET ?? '';

/**
 * Probe the same URL the browser will actually use.
 *
 * This must be the virtual-hosted form, `<bucket>.<account>.r2.cloudflarestorage.com`,
 * because that is what `getSignedUrl` produces and therefore what the browser
 * PUTs to. An earlier version of this check used the path-style form
 * (`<account>.r2.cloudflarestorage.com/<bucket>/...`), which is a different
 * request, is not covered by the bucket's CORS rule, and 403s even when the rule
 * is correct. That produced a false "CORS is not configured" and would have sent
 * someone to paste a rule that was already there.
 */
function probeUrl(): string {
  if (!ENDPOINT) return '';
  try {
    const url = new URL(ENDPOINT);
    url.host = `${BUCKET}.${url.host}`;
    return `${url.origin}/image/cors-probe`;
  } catch {
    return `${ENDPOINT}/${BUCKET}/image/cors-probe`;
  }
}

/** Both dev ports, so a port change cannot silently read as "CORS is fine". */
const CANDIDATE_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3100',
  'https://naijaproperty.ng',
];

async function probe(origin: string): Promise<{ ok: boolean; status: number; detail: string }> {
  const res = await fetch(probeUrl(), {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'content-type',
    },
  });

  const allow = res.headers.get('access-control-allow-origin');
  if (allow === '*' || allow === origin) {
    return { ok: true, status: res.status, detail: `allow-origin: ${allow}` };
  }
  return {
    ok: false,
    status: res.status,
    detail: allow ? `allow-origin: ${allow}` : 'no access-control-allow-origin header',
  };
}

async function main() {
  if (!ENDPOINT || !BUCKET) {
    console.error('R2_ENDPOINT or R2_BUCKET is not set. Check .env.');
    process.exit(1);
  }

  console.log(`Checking CORS on ${BUCKET}`);
  console.log(`Probing ${probeUrl()}\n`);

  let allOk = true;
  for (const origin of CANDIDATE_ORIGINS) {
    try {
      const { ok, status, detail } = await probe(origin);
      if (!ok) allOk = false;
      console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${origin.padEnd(32)} HTTP ${status}  ${detail}`);
    } catch (err) {
      allOk = false;
      console.log(`  ERR  ${origin.padEnd(32)} ${(err as Error).message}`);
    }
  }

  console.log('');
  if (allOk) {
    console.log('CORS is configured. Browser photo upload should work.');
    return;
  }

  console.log('CORS is not configured, so the browser cannot upload photos.');
  console.log('');
  console.log('Get the rule to paste into R2 bucket -> Settings -> CORS:');
  console.log('  npm run r2:cors -w @naijaproperty/api');
  console.log('');
  console.log('Symptom until this is done: every photo shows "Upload blocked by the');
  console.log('browser", but the bytes DO reach the bucket and are then discarded,');
  console.log('leaving orphan media rows behind.');
  process.exit(1);
}

main();
