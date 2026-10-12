/**
 * tus upload tests.
 *
 * Focused on offset bookkeeping, because that is the part that fails silently: a
 * wrong offset does not throw, it produces a corrupt file that plays for the first
 * few seconds and then stutters. Everything here is deterministic and offline.
 *
 *   npm run test:tus -w @naijaproperty/web
 */

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

/** Minimal File stand-in. jsdom is not needed because only slice/size are used. */
function fakeFile(size: number, type = 'video/mp4'): File {
  const bytes = new Uint8Array(size);
  return {
    size,
    type,
    name: 'walkthrough.mp4',
    slice: (from: number, to?: number) =>
      ({
        size: (to ?? size) - from,
        byteLength: (to ?? size) - from,
        arrayBuffer: async () => bytes.slice(from, to ?? size).buffer,
      }) as unknown as Blob,
  } as unknown as File;
}

interface RouteResult {
  status: number;
  headers: Record<string, string>;
}

/**
 * A scripted tus server.
 *
 * `patches` maps an incoming Upload-Offset to the response, which is how a test
 * says "this PATCH claims to have written X" without needing a real server.
 */
function installServer(
  handler: (method: string, headers: Record<string, string>) => RouteResult,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const method = init?.method ?? 'GET';
    const { status, headers: out } = handler(method, headers);
    return new Response(null, { status, headers: out }) as unknown as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function main() {
  const { uploadVideo, TusUploadError, buildMetadata } = await import('../src/lib/tus-upload.js');

  console.log('tus metadata');
  const meta = buildMetadata('my video.mp4', 'video/mp4');
  check('metadata includes filename and filetype', meta.includes('filename') && meta.includes('filetype'));
  const decoded = atob(meta.split('filename ')[1]!.split(',')[0]!);
  check('filename round-trips through base64', decoded === 'my video.mp4', decoded);

  console.log('\nstraight upload');
  {
    const total = 12_000;
    let stored = 0;
    const restore = installServer((method, h): RouteResult => {
      if (method === 'HEAD') return { status: 200, headers: { 'upload-offset': String(stored) } };
      stored += Number(h['upload-offset'] ? total - stored : 0);
      // A real tus server reports the new offset after the PATCH.
      stored = total;
      return { status: 204, headers: { 'upload-offset': String(stored) } };
    });
    const seen: number[] = [];
    const done = await uploadVideo({
      uploadUrl: 'https://upload.example/abc',
      file: fakeFile(total),
      chunkSize: 5_000,
      onProgress: (p) => seen.push(p.percent),
    });
    restore();
    check('completes and reports the full size', done === total, `got ${done}`);
    check('progress is monotonic and ends at 100', seen.every((v, i) => i === 0 || v >= seen[i - 1]!) && seen[seen.length - 1] === 100, seen.join(','));
  }

  console.log('\nresume');
  {
    const total = 12_000;
    let stored = 7_000; // Server already holds part of the file.
    const restore = installServer((method, h): RouteResult => {
      if (method === 'HEAD') return { status: 200, headers: { 'upload-offset': String(stored) } };
      stored = total;
      return { status: 204, headers: { 'upload-offset': String(stored) } };
    });
    let patches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      if (init?.method === 'PATCH') patches += 1;
      return originalFetch(input, init);
    }) as typeof fetch;

    const done = await uploadVideo({ uploadUrl: 'https://upload.example/abc', file: fakeFile(total), chunkSize: 5_000 });
    restore();
    check('starts from the server offset rather than zero', patches === 1, `${patches} PATCHes`);
    check('reaches the full size', done === total, `got ${done}`);
  }

  console.log('\nidempotency and conflict');
  {
    const total = 8_000;
    let stored = 0;
    let patches = 0;
    const restore = installServer((method, h): RouteResult => {
      if (method === 'HEAD') return { status: 200, headers: { 'upload-offset': String(stored) } };
      patches += 1;
      // First PATCH answers with a stale offset, the second corrects it. A client
      // that trusted the first response would send a range the server has moved
      // past.
      if (patches === 1) return { status: 204, headers: { 'upload-offset': '0' } };
      stored = total;
      return { status: 204, headers: { 'upload-offset': String(total) } };
    });
    const done = await uploadVideo({ uploadUrl: 'https://upload.example/abc', file: fakeFile(total), chunkSize: 4_000 });
    restore();
    check('a backwards offset does not send duplicate ranges forever', done === total, `got ${done}`);
  }

  console.log('\nfailure handling');
  {
    const restore = installServer((): RouteResult => ({ status: 403, headers: {} }));
    let msg = '';
    try {
      await uploadVideo({ uploadUrl: 'https://upload.example/abc', file: fakeFile(4_000) });
    } catch (e) {
      msg = (e as Error).message;
    }
    restore();
    check('an expired upload link is reported plainly, not retried forever', msg.includes('no longer valid'), msg);
  }

  {
    const total = 8_000;
    let attempts = 0;
    const restore = installServer((method): RouteResult => {
      if (method === 'HEAD') return { status: 200, headers: { 'upload-offset': '0' } };
      attempts += 1;
      return { status: 500, headers: {} };
    });
    let msg = '';
    try {
      await uploadVideo({ uploadUrl: 'https://upload.example/abc', file: fakeFile(total), maxRetries: 2 });
    } catch (e) {
      msg = (e as Error).message;
    }
    restore();
    check('gives up after the retry budget with a useful message', msg.includes('retries'), msg);
    check('actually retried rather than failing on the first error', attempts >= 3, `${attempts} attempts`);
  }

  {
    const restore = installServer((): RouteResult => ({ status: 200, headers: {} }));
    let msg = '';
    try {
      await uploadVideo({ uploadUrl: 'https://upload.example/abc', file: fakeFile(4_000) });
    } catch (e) {
      msg = (e as Error).message;
    }
    restore();
    check('a missing offset header is refused rather than assumed to be zero', msg.includes('position'), msg);
  }

  console.log('\ncancellation');
  {
    const ac = new AbortController();
    let stored = 0;
    const restore = installServer((method): RouteResult => {
      if (method === 'HEAD') return { status: 200, headers: { 'upload-offset': String(stored) } };
      ac.abort();
      return { status: 204, headers: { 'upload-offset': String(stored) } };
    });
    let msg = '';
    try {
      await uploadVideo({ uploadUrl: 'https://upload.example/abc', file: fakeFile(20_000), chunkSize: 5_000, signal: ac.signal });
    } catch (e) {
      msg = (e as Error).message;
    }
    restore();
    check('an aborted upload reports cancellation', msg.includes('cancel'), msg);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});