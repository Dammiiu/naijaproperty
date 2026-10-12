/**
 * BFF auth methods.
 *
 * Reports which sign-in methods the API is actually configured for, so the login
 * and register pages can offer Google only when it will work. Derived from the
 * API rather than a build-time constant, so enabling Google in the environment
 * needs no redeploy of the web app.
 *
 * Public by design: it exposes which integrations are switched on, which is not
 * sensitive and is already implied by which buttons render.
 */

import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';

/** Not a secret, so a short cache is enough and saves a round trip per page view. */
export const revalidate = 60;

export async function GET() {
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/methods`, {
      headers: { accept: 'application/json' },
      next: { revalidate },
    });

    if (!res.ok) throw new Error(`methods responded ${res.status}`);

    const body = (await res.json()) as {
      email?: boolean;
      google?: boolean;
      phoneOtp?: boolean;
    };

    return NextResponse.json({
      email: Boolean(body.email),
      google: Boolean(body.google),
      phoneOtp: Boolean(body.phoneOtp),
    });
  } catch {
    /*
     * Report nothing available rather than guessing.
     *
     * If the API cannot be reached the page must not offer a Google button that
     * is guaranteed to fail on submit. email/phone are always rendered
     * regardless, so the user still has a working way in.
     */
    return NextResponse.json({ email: true, google: false, phoneOtp: true });
  }
}