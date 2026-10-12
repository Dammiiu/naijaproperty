/**
 * Shared server-only constants.
 *
 * Kept apart from api.ts so that importing the session helper does not drag in
 * the search fetchers, and vice versa.
 */

export const API_URL = (
  process.env.INTERNAL_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:4000'
).replace(/\/+$/, '');

export const WEB_URL = (process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3100').replace(
  /\/+$/,
  '',
);

export const IS_PROD = process.env.NODE_ENV === 'production';