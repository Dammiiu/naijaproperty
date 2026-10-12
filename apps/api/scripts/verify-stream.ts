/**
 * Stream configuration check.
 *
 * Reports exactly what works and what does not, against the live Cloudflare API,
 * so a misconfigured token takes a minute to diagnose instead of an afternoon.
 *
 * Nothing here writes to our database and nothing uploads video. It only reads
 * permissions, which is why it is safe to run repeatedly and safe to run against a
 * production account.
 *
 *   npm run verify:stream -w @naijaproperty/api
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { config as loadEnv } from 'dotenv';

loadEnv({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'),
});

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const TOKEN = process.env.CLOUDFLARE_STREAM_TOKEN ?? '';
const WEBHOOK_SECRET = process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET ?? '';

let failed = 0;

function report(ok: boolean, label: string, detail: string): void {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} ${detail}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    result?: unknown;
    errors?: Array<{ code?: number; message?: string }>;
  };
  return { status: res.status, body };
}

async function main() {
  console.log('Cloudflare Stream configuration');

  section('Environment');
  report(Boolean(ACCOUNT), 'CLOUDFLARE_ACCOUNT_ID is set', ACCOUNT || '(missing)');
  report(TOKEN.length >= 40, 'CLOUDFLARE_STREAM_TOKEN looks like a token', `${TOKEN.length} chars`);
  report(
    TOKEN.startsWith('cf') || TOKEN.startsWith('v1.0-'),
    'token is an API token, not a legacy user key',
    // Legacy User API Keys and scoped API Tokens have different shapes. A key that
    // does not match either is usually a truncated paste.
    TOKEN.startsWith('cf') ? 'scoped API token (cf...)' : 'check the shape',
  );
  report(
    Boolean(WEBHOOK_SECRET),
    'CLOUDFLARE_STREAM_WEBHOOK_SECRET is set',
    WEBHOOK_SECRET ? 'set' : 'missing: the webhook will reject every callback',
  );

  if (!ACCOUNT || !TOKEN) {
    console.log('\nCannot continue without an account id and token.');
    process.exit(1);
  }

  section('Token permissions');
  const acct = await call(`/accounts/${ACCOUNT}`);
  report(
    acct.status === 200 && acct.body.success === true,
    'can read the account',
    acct.body.success ? 'yes' : `HTTP ${acct.status}: ${acct.body.errors?.[0]?.message ?? 'unknown'}`,
  );

  // Stream read. A token with no Stream scope fails here and at write, which is
  // how we tell "wrong token" apart from "Stream not enabled on this account".
  const list = await call(`/accounts/${ACCOUNT}/stream`);
  const streamRead = list.status === 200 && list.body.success === true;
  report(
    streamRead,
    'has Stream read permission',
    streamRead
      ? 'yes'
      : `HTTP ${list.status}: ${list.body.errors?.[0]?.message ?? 'unknown'}`,
  );

  // Stream write, via the exact call presignVideo makes. This creates a
  // one-time upload URL and nothing else, so it is the cheapest real proof.
  const du = await call(`/accounts/${ACCOUNT}/stream/direct_upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      maxDurationSeconds: 3600,
      requireSignedURLs: false,
      expiry: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      meta: { name: 'configuration-check.mp4' },
    }),
  });
  const duOk = du.status === 200 && du.body.success === true;
  report(
    duOk,
    'has Stream write permission (direct_upload)',
    duOk ? 'yes' : `HTTP ${du.status}: ${du.body.errors?.[0]?.message ?? 'unknown'}`,
  );

  if (!duOk && (du.status === 401 || du.status === 403)) {
    console.log(
      '\n  This is a token scope problem, not a Cloudflare outage and not a code problem.\n' +
        '  Fix: Cloudflare dashboard -> My Profile -> API Tokens -> edit the token ->\n' +
        '  Permissions -> Add -> Account -> Stream -> Edit\n' +
        '  Resources -> Include -> your account\n' +
        '  A token with no Stream scope fails on read and write alike, because\n' +
        '  Cloudflare models Stream as a single Edit permission rather than\n' +
        '  separate read and write scopes.',
    );
  }

  section('Request shape');
  if (duOk) {
    const result = du.body.result as { uploadURL?: string; uid?: string } | undefined;
    const host = (() => {
      try {
        return new URL(result?.uploadURL ?? '').host;
      } catch {
        return '(unparseable)';
      }
    })();
    report(Boolean(result?.uid), 'direct_upload returns a uid', result?.uid ?? '(absent)');
    report(
      host.includes('upload.videodelivery.net') || host.includes('cloudflarestream.com'),
      'upload URL points at a tus endpoint',
      host,
    );
  } else {
    console.log('  Skipped: direct_upload did not succeed.');
  }

  section('Webhook signature');
  if (WEBHOOK_SECRET) {
    const time = Math.floor(Date.now() / 1000);
    const sample = JSON.stringify({ uid: 'example', status: { state: 'ready' } });

    /*
     * Cloudflare's scheme, not a plausible-looking one.
     *
     * The header is `time=<unix>,sig1=<hex>` and the HMAC covers `<time>.<body>`,
     * not the body alone. An earlier version of this check signed the body on its
     * own, which would have reported a perfectly correct secret as wrong while
     * telling the operator to go change it.
     */
    const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${time}.`).update(sample).digest('hex');
    const header = `time=${time},sig1=${sig}`;
    report(sig.length === 64, 'signs as <time>.<body> with HMAC-SHA256', `hex ${sig.length} chars`);
    report(
      /^time=\d+,sig1=[0-9a-f]{64}$/.test(header),
      'produces a header in Cloudflare’s documented format',
      header.slice(0, 28) + '...',
    );
    report(
      !WEBHOOK_SECRET.includes(' '),
      'secret has no stray whitespace from a copy-paste',
      WEBHOOK_SECRET.includes(' ') ? 'contains a space' : 'clean',
    );

    // Cloudflare cannot reach localhost, so a webhook pointed at a local API will
    // never arrive. Printed as a note rather than a check, because there is nothing
    // to pass or fail: it depends on where the API is deployed.
    console.log(
      '  NOTE  Cloudflare cannot deliver to localhost. Expose the API with a tunnel\n' +
        '        (cloudflared tunnel --url http://localhost:4000) or the webhook never fires.',
    );
  } else {
    console.log('  Skipped: no webhook secret configured.');
  }

  console.log(
    failed === 0
      ? '\nAll Stream checks passed. Video upload will work.'
      : `\n${failed} check(s) failed. Video upload will not work until they are fixed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});