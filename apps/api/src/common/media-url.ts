/**
 * Public URL construction for stored media.
 *
 * In production every image lives in R2 and is served from `R2_PUBLIC_URL`. Until
 * an R2 bucket exists, the demo dataset points at generated placeholder files in
 * the web app's `public/demo` directory, so the browse surface is fully
 * navigable without any storage credentials. The fallback is inert in
 * production: `DEMO_MEDIA_BASE_URL` is unset there, and the function below
 * returns null, which the UI renders as a gradient placeholder rather than a
 * broken image.
 */

import { getEnv } from '../config/env.js';

/** Trailing slash on any of these would produce `//` in every URL. */
function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * URL for a stored image, or null when there is nothing to point at.
 *
 * R2 has no rewrite layer, so a public URL must address the object at its real
 * key. That makes `storageKey` mandatory rather than optional: a key can be
 * derived from the asset id, but a derived key for an object that was never
 * uploaded just produces a 404, and a broken image on a listing card is worse
 * than an honest placeholder.
 *
 * An asset row with no storage key means no bytes exist — the upload never
 * completed. The verification harness creates such rows deliberately to exercise
 * search logic without writing to the bucket, and they correctly render as the
 * gradient placeholder rather than as a request that 404s.
 */
export function publicImageUrl(
  assetId: string,
  base?: string,
  storageKey?: string | null,
): string | null {
  if (!storageKey) return null;

  const env = getEnv();
  const key = storageKey.replace(/^\/+/, '');

  const r2Base = trimBase(base ?? env.R2_PUBLIC_URL);
  if (r2Base) return `${r2Base}/${key}`;

  // Dev fallback for the pre-R2 dataset: keys under `demo/` are generated files
  // served by the web app rather than by R2.
  const demoBase = trimBase(env.DEMO_MEDIA_BASE_URL);
  if (demoBase) return `${demoBase}/${key}`;

  void assetId;
  return null;
}