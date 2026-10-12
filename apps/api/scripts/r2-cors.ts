/**
 * Prints the R2 bucket CORS rule to paste into the dashboard.
 *
 * Why a print rather than an apply: the `R2_ACCESS_KEY_ID` in `.env` is scoped
 * to objects, and `PutBucketCors` is refused with AccessDenied on a key without
 * **Account -> Workers R2 Storage -> Edit**. Rather than fail with a permission
 * error, this emits the exact JSON so the rule can be pasted into
 * R2 bucket -> Settings -> CORS, which is the intended path anyway.
 *
 * Origins are derived from WEB_URL / NEXT_PUBLIC_WEB_URL rather than hardcoded,
 * because R2 matches origins exactly: a dev port that changes from 3100 to 3000
 * silently breaks upload, and that happened here.
 *
 *   npm run r2:cors -w @naijaproperty/api
 */

import { config as loadEnv } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });

function origins(): string[] {
  const found = new Set<string>();

  // Both dev ports the web app has used, because a stale CORS rule for the wrong
  // port produces a 403 that looks identical to having no rule at all.
  found.add('http://localhost:3000');
  found.add('http://localhost:3100');

  for (const key of ['WEB_URL', 'NEXT_PUBLIC_WEB_URL']) {
    const value = process.env[key];
    if (value) found.add(value.replace(/\/+$/, ''));
  }

  found.add('https://naijaproperty.ng');
  found.add('https://www.naijaproperty.ng');

  return [...found];
}

const rules = [
  {
    AllowedOrigins: origins(),
    /*
     * HEAD matters as much as PUT: the gallery reads image dimensions with a HEAD
     * before rendering, and omitting it fails that request too.
     */
    AllowedMethods: ['GET', 'PUT', 'HEAD'],
    // The presigned PUT carries `content-type`, and a preflight that does not
    // allow it is rejected before the upload starts.
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3600,
  },
];

console.log('R2 bucket :', process.env.R2_BUCKET ?? '(not set)');
console.log('Account   :', process.env.R2_ACCOUNT_ID ?? '(not set)');
console.log('');
console.log('Paste this into R2 bucket -> Settings -> CORS:');
console.log('');
console.log(JSON.stringify(rules, null, 2));
console.log('');
console.log('Then run:  npm run r2:cors:check -w @naijaproperty/api');
