'use client';

/**
 * Walkthrough video upload.
 *
 * Optional, and the form works without it. That is deliberate: a walkthrough is
 * the single thing that most reduces fraud, because it is very hard to fake a
 * video of the actual compound, but making it mandatory would exclude everyone
 * filming on a phone in bad light, which is most of the landlords here.
 *
 * Uploads go browser to Cloudflare Stream over resumable tus. The API is not in
 * the data path, so a 200MB video costs the API nothing and a dropped connection
 * at 80% resumes rather than restarting.
 *
 * After the bytes land, encoding happens on Cloudflare's side and this polls for
 * it. The form is told when the video is genuinely playable, so a listing can
 * never reference a video that does not exist yet.
 */

import { useEffect, useRef, useState } from 'react';
import { uploadVideo, TusUploadError, type TusProgress } from '@/lib/tus-upload';

const MAX_BYTES = 2 * 1024 * 1024 * 1024;

const ACCEPTED = ['video/mp4', 'video/quicktime', 'video/webm'];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatDuration(ms: number | null): string | null {
  if (!ms || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function VideoUpload({
  videoAssetId,
  onChange,
  disabled,
}: {
  /** Set by the parent when a listing already has a video. */
  videoAssetId?: string | null;
  onChange: (assetId: string | null) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'uploading' | 'processing' | 'ready' | 'error'>(
    videoAssetId ? 'ready' : 'idle',
  );
  const [progress, setProgress] = useState<TusProgress | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleared on unmount: an interval that outlives the component keeps hitting the
  // network for a page the user has left.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }

  /**
   * Waits for Cloudflare to finish encoding.
   *
   * Polls rather than trusting the browser: the last chunk landing is not the same
   * as the video being playable, and a listing submitted in between would carry a
   * dead video. Bounded so a video that never becomes ready stops costing requests
   * and says so instead of spinning forever.
   *
   * A recursive `setTimeout` rather than `setInterval`: the delay grows with each
   * attempt, and an interval cannot change its own period. An earlier version
   * re-armed the interval with a no-op callback to fake the backoff, which
   * silently stopped the polling after the first tick and left the form waiting
   * for a state that never arrived.
   */
  function pollForReady(assetId: string): void {
    stopPolling();
    setState('processing');

    const deadline = Date.now() + 20 * 60 * 1000;
    let attempts = 0;

    const tick = async () => {
      attempts += 1;

      try {
        const res = await fetch('/api/post/media', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'video-status', assetId }),
        });
        const body = (await res.json().catch(() => null)) as
          | { status?: string; durationMs?: number | null; playbackHls?: string | null }
          | { error?: { message?: string } }
          | null;

        if (res.ok && body && 'status' in body) {
          /*
           * READY with a playback URL, not READY on its own.
           *
           * The asset is marked ready when the webhook lands, and the URL is written
           * in the same update, so in practice they arrive together. Checking both
           * means a half-written row shows as still processing rather than as a
           * player that cannot load.
           */
          if (body.status === 'READY' && body.playbackHls) {
            stopPolling();
            setDurationMs(body.durationMs ?? null);
            setState('ready');
            onChange(assetId);
            return;
          }
          if (body.status === 'FAILED') {
            stopPolling();
            setState('error');
            setError('Cloudflare could not process that video. Try a different file.');
            onChange(null);
            return;
          }
        }
      } catch {
        // A transient failure is not a failure of the upload; the next tick tries
        // again and the deadline still applies.
      }

      if (Date.now() > deadline) {
        stopPolling();
        setState('error');
        setError(
          'The video is taking longer than expected to process. You can still submit the listing ' +
            'without it and add it later.',
        );
        onChange(null);
        return;
      }

      // 4s growing to 15s. Encoding a long video takes minutes and asking more
      // often does not make it finish sooner.
      const nextMs = Math.min(4_000 + attempts * 1_000, 15_000);
      pollRef.current = setTimeout(tick, nextMs);
    };

    pollRef.current = setTimeout(tick, 4_000);
  }

  async function handleFile(file: File) {
    setError(null);
    setFileName(file.name);
    setProgress({ uploaded: 0, total: file.size, percent: 0 });
    setState('uploading');

    // Validate before asking for a presign. A rejected file should cost nothing.
    if (!ACCEPTED.includes(file.type)) {
      setState('error');
      setError('Use an MP4, MOV or WebM file. Phones record in those formats.');
      setProgress(null);
      return;
    }
    if (file.size > MAX_BYTES) {
      setState('error');
      setError(`That video is ${formatBytes(file.size)}. The limit is 2GB.`);
      setProgress(null);
      return;
    }

    try {
      const presign = (await (
        await fetch('/api/post/media', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'presign',
            kind: 'video',
            fileName: file.name,
            contentType: file.type,
            bytes: file.size,
          }),
        })
      ).json()) as { assetId?: string; uploadUrl?: string; error?: { message?: string } };

      if (!presign.assetId || !presign.uploadUrl) {
        setState('error');
        setError(presign.error?.message ?? 'Could not start the video upload.');
        setProgress(null);
        return;
      }

      abortRef.current = new AbortController();
      await uploadVideo({
        uploadUrl: presign.uploadUrl,
        file,
        fileName: file.name,
        signal: abortRef.current.signal,
        onProgress: setProgress,
      });

      // Bytes are away; now wait for Cloudflare to finish encoding.
      pollForReady(presign.assetId);
    } catch (err) {
      stopPolling();
      setProgress(null);
      if (err instanceof TusUploadError) {
        setState('error');
        setError(err.message);
        return;
      }
      setState('error');
      setError('The video upload failed. Check your connection and try again.');
    }
  }

  function cancel() {
    abortRef.current?.abort();
    stopPolling();
    setState('idle');
    setProgress(null);
    setFileName(null);
    setError(null);
    onChange(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="videoupload">
      <div className="videoupload__head">
        <span className="field__label">Walkthrough video</span>
        <span className="field__optional">optional</span>
      </div>

      <p className="field__note">
        A short walkthrough from the gate is the single thing that stops someone pretending to
        own a property. MP4, MOV or WebM, up to 2GB. On mobile data a large video can take a
        while; it resumes if your connection drops.
      </p>

      {state === 'idle' || state === 'error' ? (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(',')}
            className="visually-hidden"
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <button
            type="button"
            className="btn btn--ghost"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            Choose a video
          </button>
        </>
      ) : null}

      {state === 'uploading' ? (
        <div className="videoupload__progress" role="status" aria-live="polite">
          <p className="videoupload__name">{fileName}</p>
          <div
            className="videoupload__bar"
            role="progressbar"
            aria-valuenow={progress?.percent ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className="videoupload__fill" style={{ width: `${progress?.percent ?? 0}%` }} />
          </div>
          <p className="videoupload__pct">
            {progress
              ? `${progress.percent}% · ${formatBytes(progress.uploaded)} of ${formatBytes(progress.total)}`
              : 'Starting…'}
          </p>
          <button type="button" className="btn btn--ghost btn--tiny" onClick={cancel}>
            Cancel
          </button>
        </div>
      ) : null}

      {state === 'processing' ? (
        <div className="videoupload__progress" role="status" aria-live="polite">
          <p className="videoupload__name">{fileName}</p>
          <p className="videoupload__pct">
            Uploaded. Converting for playback, usually a minute or two. You can keep filling in
            the form.
          </p>
          <button type="button" className="btn btn--ghost btn--tiny" onClick={cancel}>
            Remove
          </button>
        </div>
      ) : null}

      {state === 'ready' ? (
        <div className="videoupload__ready" role="status">
          <p className="videoupload__name">
            Video attached{durationMs ? ` · ${formatDuration(durationMs)}` : ''}
          </p>
          <button type="button" className="btn btn--ghost btn--tiny" onClick={cancel}>
            Remove
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="composer__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}