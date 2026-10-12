/**
 * Resumable video upload to Cloudflare Stream (tus 1.0.0).
 *
 * Implemented directly rather than with a library. Two reasons: the dependency is
 * ~15KB of browser code for a protocol we use once, and the part that actually
 * matters here, offset bookkeeping, is small enough to unit test.
 *
 * Why resumable at all: a property walkthrough is hundreds of megabytes and the
 * audience is on mobile data. A failed upload at 80% that has to start again is
 * the reason people give up and post without a video, which is exactly the
 * listing quality problem this project exists to fix.
 *
 * Protocol, per chunk:
 *   HEAD  uploadUrl            -> Upload-Offset (where the server actually is)
 *   PATCH uploadUrl            -> body is a byte range, Upload-Offset: <from>
 *                                 responds 204 with the new Upload-Offset
 *
 * The server's offset is always the source of truth. A local counter that
 * assumed the last PATCH succeeded would corrupt the file after any retry, and
 * Cloudflare silently accepts a mismatched range only sometimes.
 */

export interface TusProgress {
  /** Bytes the server has confirmed. */
  uploaded: number;
  total: number;
  /** 0-100, integer. */
  percent: number;
}

export interface TusOptions {
  uploadUrl: string;
  file: File;
  /** Filename sent as tus metadata so the Stream dashboard shows something useful. */
  fileName?: string;
  /** 5MB. Large enough that per-request overhead is negligible, small enough to retry cheaply. */
  chunkSize?: number;
  /** Attempts per chunk before giving up. */
  maxRetries?: number;
  onProgress?: (progress: TusProgress) => void;
  signal?: AbortSignal;
}

export class TusUploadError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TusUploadError';
  }
}

const DEFAULT_CHUNK = 5 * 1024 * 1024;
const DEFAULT_RETRIES = 4;

/** Base64 of the metadata value. tus metadata is base64, per the spec. */
function encodeMetadata(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function buildMetadata(fileName: string, contentType: string): string {
  return [
    `filename ${encodeMetadata(fileName)}`,
    `filetype ${encodeMetadata(contentType)}`,
  ].join(',');
}

/**
 * Reads the server's confirmed offset.
 *
 * Cloudflare answers 200 with an empty body and the offset in the header. A
 * missing header means the upload URL is not a live tus endpoint (an expired
 * direct-upload URL, typically), which must be reported rather than treated as
 * offset zero: restarting from zero against a URL that rejects creation would fail
 * confusingly and repeatedly.
 */
async function serverOffset(uploadUrl: string, signal?: AbortSignal): Promise<number> {
  const res = await fetch(uploadUrl, { method: 'HEAD', signal });
  if (!res.ok) {
    throw new TusUploadError(
      `The upload link is no longer valid (HTTP ${res.status}). Start the upload again.`,
    );
  }
  const raw = res.headers.get('Upload-Offset');
  if (raw === null) {
    throw new TusUploadError(
      'The upload service did not report a position, so the upload cannot resume safely.',
    );
  }
  const offset = Number.parseInt(raw, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    throw new TusUploadError(`The upload service reported an invalid position (${raw}).`);
  }
  return offset;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new TusUploadError('Upload cancelled'));
      },
      { once: true },
    );
  });
}

/**
 * Uploads a file, resuming from wherever the server says it got to.
 *
 * Returns the number of bytes the server confirmed. Throws `TusUploadError` on a
 * permanent failure; a cancelled upload also throws, so the caller can tell the
 * difference between "stopped on purpose" and "gave up".
 */
export async function uploadVideo(options: TusOptions): Promise<number> {
  const {
    uploadUrl,
    file,
    fileName = file.name || 'walkthrough.mp4',
    chunkSize = DEFAULT_CHUNK,
    maxRetries = DEFAULT_RETRIES,
    onProgress,
    signal,
  } = options;

  const total = file.size;
  let uploaded = await serverOffset(uploadUrl, signal);

  const emit = () => {
    onProgress?.({
      uploaded,
      total,
      percent: total === 0 ? 100 : Math.min(100, Math.round((uploaded / total) * 100)),
    });
  };

  emit();

  while (uploaded < total) {
    if (signal?.aborted) throw new TusUploadError('Upload cancelled');

    const end = Math.min(uploaded + chunkSize, total);
    const chunk = file.slice(uploaded, end);

    let attempt = 0;
    // Retries re-read the offset rather than assuming the failed chunk landed. A
    // PATCH that timed out may well have been applied, and resuming from a stale
    // local offset would corrupt the file.
    for (;;) {
      try {
        const res = await fetch(uploadUrl, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/offset+octet-stream',
            'Upload-Offset': String(uploaded),
            'Tus-Resumable': '1.0.0',
            'Upload-Metadata': buildMetadata(fileName, file.type || 'video/mp4'),
          },
          body: chunk,
          signal,
        });

        if (res.status === 409) {
          // Offset conflict: our view of the file disagrees with the server's.
          // The server wins, always.
          uploaded = await serverOffset(uploadUrl, signal);
          emit();
          break;
        }

        if (!res.ok) {
          throw new TusUploadError(`Upload rejected (HTTP ${res.status})`);
        }

        const reported = res.headers.get('Upload-Offset');
        const next = reported === null ? end : Number.parseInt(reported, 10);
        if (!Number.isFinite(next) || next < uploaded) {
          // A response that moves backwards, or reports nothing usable, means we
          // cannot trust our own bookkeeping. Re-read rather than guess.
          uploaded = await serverOffset(uploadUrl, signal);
        } else {
          uploaded = next;
        }
        emit();
        break;
      } catch (err) {
        if (err instanceof TusUploadError && err.message.includes('no longer valid')) throw err;
        if (signal?.aborted) throw new TusUploadError('Upload cancelled');

        attempt += 1;
        if (attempt > maxRetries) {
          throw new TusUploadError(
            `Upload failed after ${maxRetries} retries at ${Math.round(
              (uploaded / total) * 100,
            )}%.`,
            err,
          );
        }

        // Exponential backoff. A network that just failed is unlikely to succeed
        // immediately, and retrying in a tight loop just burns the battery of a
        // phone that is already struggling.
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000), signal);
        try {
          uploaded = await serverOffset(uploadUrl, signal);
          emit();
        } catch {
          // Keep the previous offset and retry the chunk; the next attempt will
          // re-read it anyway.
        }
      }
    }
  }

  return uploaded;
}