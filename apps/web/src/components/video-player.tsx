'use client';

/**
 * Walkthrough video player.
 *
 * Cloudflare Stream serves HLS, not MP4. HLS plays natively in Safari and on iOS
 * but NOT in Chrome, Firefox, Edge or Android Chrome, which is where most people
 * looking for property in Nigeria actually are. A bare `<video>` with an
 * `application/vnd.apple.mpegurl` source therefore shows a broken player to the
 * majority of visitors and looks like the listing has no video at all.
 *
 * So: native playback where it exists, hls.js where it does not. hls.js is
 * imported dynamically rather than statically because Safari users would
 * otherwise download a library they never execute, and a poster image is a much
 * better first paint than a large script.
 *
 * Autoplay is deliberately off. A walkthrough with sound that starts on its own
 * is hostile, and mobile browsers block it anyway.
 */

import { useEffect, useRef, useState } from 'react';

export function VideoPlayer({
  src,
  poster,
  title,
}: {
  /** The HLS manifest URL from Cloudflare Stream. */
  src: string;
  poster?: string | null;
  title: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  // Rendered until playback is confirmed working, so a library that fails to load
  // degrades to a visible poster rather than an empty black rectangle.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: import('hls.js').default | null = null;
    let cancelled = false;

    // Safari, and any browser that reports native HLS support, plays the manifest
    // directly. Setting src on the element and walking away is all that is needed.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      setReady(true);
      return;
    }

    void (async () => {
      try {
        const mod = await import('hls.js');
        if (cancelled) return;
        const Hls = mod.default;

        if (!Hls.isSupported()) {
          // No native HLS and no MSE (some older mobile browsers). Nothing can
          // play this, so say so rather than leaving a dead control.
          setFailed(true);
          return;
        }

        hls = new Hls({
          // Nigerian mobile connections drop constantly. Without retries a single
          // 2xx-worth stall leaves the video spinning forever.
          enableWorker: true,
          lowLatencyMode: false,
          fragLoadingMaxRetry: 6,
          manifestLoadingMaxRetry: 4,
          // Cap the buffer. An unbounded buffer on a long walkthrough will happily
          // download the whole file on mobile data.
          backBufferLength: 90,
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          // Fatal only: hls.js emits recoverable warnings constantly and treating
          // those as failures would flash an error on videos that then play fine.
          if (data.fatal) {
            setFailed(true);
            hls?.destroy();
            hls = null;
          }
        });

        hls.loadSource(src);
        hls.attachMedia(video);
        setReady(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [src]);

  if (failed) {
    return (
      <div className="detail__video-pending">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" />
        ) : null}
        <p>
          This browser cannot play the walkthrough video.{' '}
          <a href={src} target="_blank" rel="noreferrer">
            Open it directly
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      className="detail__video"
      controls
      playsInline
      preload="metadata"
      poster={poster ?? undefined}
      aria-label={title}
      // Hidden until a source is attached, so a Safari video element with no src
      // does not render as a blank black bar during hydration.
      style={ready ? undefined : { display: 'none' }}
    >
      Your browser cannot play this video.{' '}
      <a href={src}>Open the video directly.</a>
    </video>
  );
}
