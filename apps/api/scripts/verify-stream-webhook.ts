/**
 * Stream webhook regression checks.
 *
 * These exist because the first version of the handler was wrong in three ways
 * that all failed silently. Each one returned HTTP 200 while doing nothing, which
 * in production looks exactly like "Cloudflare is not calling us":
 *
 *   1. Read the video from `body.video`. Cloudflare sends it at the TOP level, so
 *      every real callback was acknowledged as `ignored`.
 *   2. Treated `status` as a string. It is an object `{ state, pctComplete, ... }`,
 *      so `READY_STATES.has(status)` never matched and no video ever became ready.
 *   3. Compared a bare hex HMAC of the body against the whole
 *      `Webhook-Signature` header. The header is `time=<unix>,sig1=<hex>` over
 *      `<time>.<body>`, so verification rejected 100% of genuine callbacks.
 *
 * The fixtures below are Cloudflare's documented examples, so a future change to
 * the real shape breaks these first.
 *
 *   npm run verify:stream-webhook -w @naijaproperty/api
 */

import { createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

/*
 * Load .env, as every other harness in this folder does.
 *
 * Without this the script silently depended on the secret already being exported
 * into the shell, so it passed for whoever had exported it and failed for
 * everyone else with a misleading "cannot verify the handler". A harness whose
 * pass/fail depends on how you launched it is not a harness.
 */
loadEnv({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'),
});

const prisma = new PrismaClient();
const SECRET = process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET ?? '';
const URL = 'http://localhost:4000/api/v1/media/stream/webhook';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`);
  }
}

/**
 * Signs a payload the way Cloudflare documents: `time=<unix>,sig1=<hex>` where
 * the HMAC covers `<time>.<raw body>`.
 */
function sign(body: string, offsetSeconds = 0): string {
  const time = Math.floor(Date.now() / 1000) + offsetSeconds;
  const sig = createHmac('sha256', SECRET).update(`${time}.`).update(body).digest('hex');
  return `time=${time},sig1=${sig}`;
}

async function post(payload: unknown, signature: string) {
  const text = JSON.stringify(payload);
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-signature': signature },
    body: text,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function main() {
  if (!SECRET) {
    console.log('CLOUDFLARE_STREAM_WEBHOOK_SECRET is not set; cannot verify the handler.');
    process.exit(1);
  }

  const auth = (await (
    await fetch('http://localhost:4000/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'demo.ada@listers.ng', password: 'DemoPass!2026njp' }),
    })
  ).json()) as { accessToken: string; user: { id: string } };

  const asset = await prisma.mediaAsset.create({
    data: {
      ownerId: auth.user.id,
      kind: 'VIDEO',
      status: 'UPLOADING',
      mime: 'video/mp4',
      bytes: BigInt(5_000_000),
      streamUid: 'verifyuid0000000000000000001',
    },
  });
  const uid = asset.streamUid!;

  // Cloudflare's own "ready" example, with meta.assetId swapped for our asset.
  // Shape matters more than the values here.
  const readyPayload = {
    uid,
    creator: null,
    thumbnail: `https://customer-f33zs165nr7gyfy4.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg`,
    thumbnailTimestampPct: 0,
    readyToStream: true,
    status: { state: 'ready', pctComplete: '100.000000', errorReasonCode: '', errorReasonText: '' },
    meta: { assetId: asset.id, name: 'walkthrough.mp4' },
    created: '2022-06-30T17:53:12.512033Z',
    modified: '2022-06-30T17:53:21.774299Z',
    size: 383631,
    preview: `https://customer-f33zs165nr7gyfy4.cloudflarestream.com/${uid}/watch`,
    allowedOrigins: [],
    requireSignedURLs: false,
    uploaded: '2022-06-30T17:53:12.511981Z',
    uploadExpiry: '2022-07-01T17:53:12.511973Z',
    maxSizeBytes: null,
    maxDurationSeconds: null,
    duration: 5.5,
    input: { width: 560, height: 320 },
    playback: {
      hls: `https://customer-f33zs165nr7gyfy4.cloudflarestream.com/${uid}/manifest/video.m3u8`,
      dash: `https://customer-f33zs165nr7gyfy4.cloudflarestream.com/${uid}/manifest/video.mpd`,
    },
    watermark: null,
  };

  console.log('signature gate');
  {
    const noSig = await post(readyPayload, '');
    check('a missing signature is refused', noSig.status === 401, `got ${noSig.status}`);

    const wrong = await post(readyPayload, `time=${Math.floor(Date.now() / 1000)},sig1=${'0'.repeat(64)}`);
    check('a wrong signature is refused', wrong.status === 401, `got ${wrong.status}`);

    // A bare hex digest with no `time=` prefix. This is what the first
    // implementation compared against, and accepting it would mean any request
    // signed the naive way could publish a video.
    const bare = createHmac('sha256', SECRET).update(JSON.stringify(readyPayload)).digest('hex');
    const bareOnly = await post(readyPayload, bare);
    check('a bare body-only HMAC without the time component is refused', bareOnly.status === 401, `got ${bareOnly.status}`);

    // Replay: a correctly signed but stale request. The signature stays valid
    // forever, so freshness has to be checked separately.
    const stale = sign(JSON.stringify(readyPayload), -3600);
    const replayed = await post(readyPayload, stale);
    check('a correctly signed but hour-old request is refused as stale', replayed.status === 401, `got ${replayed.status}`);
  }

  console.log('\ndocumented ready payload');
  {
    const good = await post(readyPayload, sign(JSON.stringify(readyPayload)));
    check('the top-level video shape is accepted', good.status === 200 && good.body.ready === true, JSON.stringify(good.body));

    const row = await prisma.mediaAsset.findUnique({
      where: { id: asset.id },
      select: { status: true, durationMs: true, width: true, height: true, playbackHls: true, posterUrl: true },
    });
    check('the asset becomes READY', row?.status === 'READY', row?.status);
    // 5.5 seconds. Storing 5 would render as 0:05 by accident on short clips and
    // 0:00 on sub-second ones.
    check('duration is stored in milliseconds', row?.durationMs === 5500, String(row?.durationMs));
    check('dimensions are recorded', row?.width === 560 && row?.height === 320, `${row?.width}x${row?.height}`);
    check(
      'the HLS manifest is taken verbatim from the payload',
      row?.playbackHls === readyPayload.playback.hls,
      row?.playbackHls ?? '(null)',
    );
    check('the poster is taken from the thumbnail field', row?.posterUrl === readyPayload.thumbnail, row?.posterUrl ?? '(null)');

    const replay = await post(readyPayload, sign(JSON.stringify(readyPayload)));
    check('a retry of the same event is deduplicated, not an error', replay.status === 200 && replay.body.duplicate === true, JSON.stringify(replay.body));
  }

  console.log('\ndocumented error payload');
  {
    // Cloudflare's error example, using the `errReason*` spelling their example
    // shows (the field list spells it `errorReason*`; both must be read).
    await prisma.webhookEvent.deleteMany({ where: { provider: 'CLOUDFLARE_STREAM' } });
    const errPayload = {
      uid,
      readyToStream: false,
      status: {
        state: 'error',
        step: 'encoding',
        pctComplete: '39',
        errReasonCode: 'ERR_MALFORMED_VIDEO',
        errReasonText: 'The video was deemed to be corrupted or malformed.',
      },
      meta: { assetId: asset.id },
    };
    const e = await post(errPayload, sign(JSON.stringify(errPayload)));
    check('an error state is accepted', e.status === 200 && e.body.failed === true, JSON.stringify(e.body));

    const row = await prisma.mediaAsset.findUnique({
      where: { id: asset.id },
      select: { status: true, moderationNotes: true },
    });
    check('the asset is marked FAILED', row?.status === 'FAILED', row?.status);
    check(
      'the reason is captured from the errReasonText spelling',
      row?.moderationNotes === 'The video was deemed to be corrupted or malformed.',
      row?.moderationNotes ?? '(null)',
    );
  }

  console.log('\nisolation');
  {
    await prisma.webhookEvent.deleteMany({ where: { provider: 'CLOUDFLARE_STREAM' } });

    // A uid that names an asset already bound to a different uid. If this were
    // applied, the wrong video would be published on the wrong listing.
    const wrongUid = {
      uid: 'verifyuid0000000000000000009',
      readyToStream: true,
      status: { state: 'ready', pctComplete: '100', errorReasonCode: '', errorReasonText: '' },
      playback: { hls: 'https://evil.example/manifest.m3u8' },
      meta: { assetId: asset.id },
    };
    const w = await post(wrongUid, sign(JSON.stringify(wrongUid)));
    check('a uid that contradicts the binding is refused', w.status === 200 && w.body.ignored === true, JSON.stringify(w.body));

    const stillFailed = await prisma.mediaAsset.findUnique({ where: { id: asset.id }, select: { status: true } });
    check('the refused event did not overwrite the asset', stillFailed?.status === 'FAILED', stillFailed?.status);

    const unknown = {
      uid: 'verifyuid0000000000000000008',
      status: { state: 'ready', pctComplete: '100', errorReasonCode: '', errorReasonText: '' },
      meta: { assetId: 'cmzzzzzzzzzzzzzzzzzzzzzzzz' },
    };
    const u = await post(unknown, sign(JSON.stringify(unknown)));
    check('an unknown asset is acknowledged so Cloudflare stops retrying', u.status === 200 && u.body.unmatched === true, JSON.stringify(u.body));

    const legacy = { video: { uid: 'verifyuid0000000000000000007', status: { state: 'ready' } } };
    const l = await post(legacy, sign(JSON.stringify(legacy)));
    check('the older nested `video` shape is also understood', l.status === 200 && l.body.unmatched === true, JSON.stringify(l.body));
  }

  await prisma.webhookEvent.deleteMany({ where: { provider: 'CLOUDFLARE_STREAM' } });
  await prisma.mediaAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
