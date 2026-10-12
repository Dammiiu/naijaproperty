/**
 * BFF for the media upload path used by the post-a-property form.
 *
 * The browser never holds a token. It asks this route for a presigned URL, PUTs
 * the bytes straight to R2, then asks this route to confirm and process. R2 is
 * the only party that sees the image bytes, they never pass through Next.js or
 * the API, which is the whole point of the direct-upload architecture.
 *
 * `kind` selects which presign endpoint is proxied. Videos are routed but Stream
 * is not configured yet, so that branch returns a clear error rather than a URL
 * that cannot work.
 */

import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

async function forward(path: string, init: RequestInit): Promise<NextResponse> {
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in again to continue' } },
      { status: 401 },
    );
  }

  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
    });

    const payload = await res.json().catch(() => null);
    return NextResponse.json(payload, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Could not reach the upload service' } },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  // Checked up front so an anonymous visitor gets 401 before anything else runs.
  if (!(await getAccessToken())) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in to upload photos' } },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Expected a JSON body' } },
      { status: 400 },
    );
  }

  switch (body.action as string | undefined) {
    case 'presign': {
      const kind =
        body.kind === 'video' ? 'videos' : body.kind === 'document' ? 'documents' : 'images';

      return forward(`/api/v1/media/${kind}/presign`, {
        method: 'POST',
        body: JSON.stringify({
          fileName: body.fileName,
          contentType: body.contentType,
          bytes: body.bytes,
        }),
      });
    }

    case 'complete':
      return forward('/api/v1/media/images/complete', {
        method: 'POST',
        body: JSON.stringify({ assetId: body.assetId, contentHash: body.contentHash }),
      });

    case 'process':
      return forward('/api/v1/media/images/process', {
        method: 'POST',
        body: JSON.stringify({ assetId: body.assetId }),
      });

    /*
     * Video status.
     *
     * A video is confirmed by Cloudflare's webhook, not by the browser: the bytes
     * go straight to Stream and encoding finishes whenever it finishes. So the
     * client polls this rather than assuming success the moment its last chunk
     * lands. Without it the form would either submit too early (a listing with a
     * dead video) or block forever on a large file.
     */
    case 'video-status': {
      const assetId = typeof body.assetId === 'string' ? body.assetId : '';
      if (!assetId) {
        return NextResponse.json(
          { error: { code: 'BAD_REQUEST', message: 'An asset id is required' } },
          { status: 400 },
        );
      }
      return forward(`/api/v1/media/${encodeURIComponent(assetId)}`, { method: 'GET' });
    }

    default:
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: `Unknown action: ${String(body.action)}` } },
        { status: 400 },
      );
  }
}