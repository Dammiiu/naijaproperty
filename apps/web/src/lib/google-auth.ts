'use client';

/**
 * Whether Google sign-in is available.
 *
 * The API owns this decision: `/auth/methods` reports Google as configured only
 * when both the client id and the client secret are present. Asking the API
 * rather than baking a boolean into the bundle means the button appears the
 * moment the credentials are added to the environment and disappears if they
 * are removed, with no rebuild.
 *
 * Defaults to false, so the button is never shown until the answer arrives. That
 * is the safe direction: briefly hiding a working option is a smaller problem
 * than briefly showing a button that 500s.
 *
 * Module-level promise so several components on a page share one request rather
 * than each firing their own.
 */

let cached: Promise<boolean> | null = null;

export function isGoogleAvailable(): Promise<boolean> {
  cached ??= fetch('/api/auth/methods', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => Boolean(body?.google))
    .catch(() => false);
  return cached;
}

/**
 * Starts the Google OAuth flow.
 *
 * A full navigation to the API, not a fetch. The endpoint responds 302 to
 * accounts.google.com and parks the CSRF nonce in a cookie on the API origin, so
 * this has to be a real browser navigation. `window.location.assign` is used
 * rather than an anchor for the same reason, and so the return path survives
 * through Google's round trip.
 *
 * The `next` destination is passed in the fragment, which never reaches a
 * server. Putting it in the query string would let an attacker point a victim at
 * a crafted URL that redirects them elsewhere after sign-in.
 */
export function startGoogleSignIn(next: string): void {
  const target = `/api/v1/auth/google/start#next=${encodeURIComponent(next)}`;
  const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
  window.location.assign(`${apiBase}${target}`);
}