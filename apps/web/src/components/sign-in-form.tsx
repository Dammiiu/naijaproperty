'use client';

/**
 * Sign-in form.
 *
 * Posts to the web app's own BFF route rather than straight to the API, so the
 * refresh token lands in an httpOnly cookie on this origin and never in
 * JavaScript.
 *
 * Error handling distinguishes the cases a Nigerian user will actually hit -
 * wrong password, unverified account, rate limited, because "sign-in failed" on
 * all three is the reason people give up and post on a classifieds site instead.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

interface ApiError {
  code?: string;
  message?: string;
  fields?: Record<string, string>;
}

export function SignInForm({ nextPath }: { nextPath?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  // The server passes the destination through, but the query parameter is read
  // too so a client-side navigation that changes it is respected.
  const next = nextPath ?? params.get('next') ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = (await res.json()) as ApiError & { user?: unknown };

      if (!res.ok) {
        setError(body);
        return;
      }

      // Full navigation rather than a client push, so the server components on
      // the destination re-render with the new session cookie in place. A
      // client-side push would show a signed-out page until a hard refresh.
      window.location.assign(next);
    } catch {
      setError({ message: 'Could not reach the sign-in service. Check your connection.' });
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <div className="auth">
      <h1 className="auth__title">Sign in</h1>
      <p className="auth__lede">
        You do not need an account to browse. Sign in only when you want to see an exact address, a
        phone number, or to message an owner.
      </p>

      <form className="auth__form" onSubmit={submit} noValidate>
        <div className="field">
          <label className="field__label" htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            className="field__input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error?.fields?.email ? true : undefined}
            aria-describedby={error?.fields?.email ? 'email-error' : undefined}
          />
          {error?.fields?.email ? (
            <p className="field__error" id="email-error">
              {error.fields.email}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="field__input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error?.fields?.password ? true : undefined}
            aria-describedby={error?.fields?.password ? 'password-error' : undefined}
          />
          {error?.fields?.password ? (
            <p className="field__error" id="password-error">
              {error.fields.password}
            </p>
          ) : null}
        </div>

        {error && !error.fields ? (
          <p className="auth__error" role="alert">
            {messageFor(error)}
          </p>
        ) : null}

        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="auth__alt">
        <p>
          No account yet? <Link href="/register">Join Naijaproperty</Link>
        </p>
        <p className="auth__note">
          Prefer your phone number? <Link href="/register?method=otp">Sign up with a one-time code</Link>{' '}
         , no password to forget.
        </p>
      </div>
    </div>
  );
}

/** Turns the API's error code into something a person can act on. */
function messageFor(error: ApiError): string {
  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return 'That email and password do not match an account.';
    case 'ACCOUNT_LOCKED':
      return 'This account is temporarily locked after too many failed attempts. Try again later.';
    case 'ACCOUNT_SUSPENDED':
      return 'This account is suspended. Contact support if you think that is wrong.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Wait a minute and try again.';
    case 'VALIDATION_FAILED':
      return error.message ?? 'Check the details and try again.';
    default:
      return error.message ?? 'Sign-in failed. Please try again.';
  }
}