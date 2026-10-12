/**
 * Shared server-only constants.
 *
 * Kept apart from api.ts so that importing the session helper does not drag in
 * the search fetchers, and vice versa.
 */

/**
 * Reads a URL-valued environment variable, treating a blank value as absent.
 *
 * This exists because `??` is the wrong operator for configuration.
 *
 * `process.env.FOO ?? 'default'` only falls back when FOO is null or undefined.
 * An **empty string is neither**, so a variable that is declared but blank --
 * which is what a shell with `FOO=`, a CI job with an unset secret, or a
 * Dockerfile `ARG` forwarded into `ENV` without a value all produce -- defeats
 * the fallback entirely. The result is an empty base URL, and the first thing
 * that tries to parse it throws `ERR_INVALID_URL`.
 *
 * That failure surfaces during `next build` as an opaque
 * "Failed to collect page data for /_not-found", which points at the not-found
 * page rather than at the configuration that caused it.
 *
 * Blank is treated as absent everywhere a URL is read, so a missing variable
 * degrades to a working local default instead of failing the build.
 */
function envUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return (trimmed ? trimmed : fallback).replace(/\/+$/, '');
}

/**
 * Public origin of this site, used for canonical and Open Graph URLs.
 *
 * Blank is treated as absent here for the same reason as `API_URL`. This is the
 * function that used to crash `next build` with ERR_INVALID_URL when the variable
 * was present but empty.
 */
export function webOrigin(): string {
  return envUrl(process.env.NEXT_PUBLIC_WEB_URL, 'http://localhost:3000');
}

/**
 * Origin of the API.
 *
 * INTERNAL_API_URL wins so the server-to-server path can bypass the public
 * hostname (and any CDN in front of it), which is what you want on Cloudflare
 * where the edge and the API are different providers.
 */
export const API_URL = envUrl(
  process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL,
  'http://localhost:4000',
);

export const IS_PROD = process.env.NODE_ENV === 'production';
