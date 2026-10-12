'use client';

/**
 * Sign-up form.
 *
 * Two methods on one page, chosen by a segmented control rather than two URLs.
 * Email and password is the default because it is what people expect; the phone
 * one-time code is offered beside it because a large share of users will not want
 * a password, and Termii is already wired for delivery.
 *
 * The password rules are shown before submission rather than only on rejection.
 * A rule that only appears when you fail it is a rule most people read as an
 * insult, and they usually give up on the first rejection.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { GoogleSignInButton } from '@/components/google-signin-button';

interface ApiError {
  code?: string;
  message?: string;
  fields?: Record<string, string>;
  details?: Array<{ path: string; message: string }>;
}

type Method = 'email' | 'otp';

export function RegisterForm({ nextPath }: { nextPath?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = nextPath ?? params.get('next') ?? '/dashboard';

  const initialMethod: Method = params.get('method') === 'otp' ? 'otp' : 'email';

  const [method, setMethod] = useState<Method>(initialMethod);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  // Client-side mirror of the contract's password rule, so the live feedback is
  // immediate. The server still enforces it; this is not a substitute.
  const passwordRules = [
    { label: 'At least 8 characters', ok: password.length >= 8 },
    { label: 'A lowercase letter', ok: /[a-z]/.test(password) },
    { label: 'An uppercase letter', ok: /[A-Z]/.test(password) },
    { label: 'A number', ok: /\d/.test(password) },
  ];
  const passwordOk = passwordRules.every((r) => r.ok);

  async function sendOtp() {
    setSendingOtp(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/auth/otp/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, clientHint: 'AUTO' }),
      });
      const body = (await res.json().catch(() => null)) as ApiError & {
        channel?: string;
        expiresInSeconds?: number;
      } | null;

      if (!res.ok) {
        setError(body ?? { message: 'Could not send a code to that number.' });
        return;
      }

      setOtpSent(true);
      /*
       * Names the channel that actually delivered. If WhatsApp is not configured
       * the code lands by SMS, and saying so up front is the difference between
       * "it works" and "I have been waiting for a WhatsApp message that will never
       * come".
       */
      setNotice(
        body?.channel === 'SMS'
          ? 'Sent by SMS. It can take a minute on some networks.'
          : 'Sent. It can take a minute to arrive.',
      );
    } catch {
      setError({ message: 'Could not reach the service. Check your connection.' });
    } finally {
      setSendingOtp(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      if (method === 'otp') {
        if (!otpSent) {
          await sendOtp();
          return;
        }

        const verify = await fetch('/api/auth/otp/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phone, code: otp }),
        });
        const body = (await verify.json().catch(() => null)) as ApiError | null;

        if (!verify.ok) {
          setError(body ?? { message: 'That code did not work. Check it and try again.' });
          return;
        }

        // Full navigation so server components pick up the new cookie.
        window.location.assign(next);
        return;
      }

      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName,
          email,
          password,
          // Omitted rather than sent empty: the contract treats a blank string as
          // a supplied phone number and fails to parse it.
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          acceptedTerms: true,
        }),
      });

      const body = (await res.json()) as ApiError;
      if (!res.ok) {
        setError(withFieldMap(body));
        return;
      }

      window.location.assign(next);
    } catch {
      setError({ message: 'Could not reach the service. Check your connection.' });
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <div className="auth">
      <h1 className="auth__title">Join Naijaproperty</h1>
      <p className="auth__lede">
        Free to list, free to contact owners. You need an account to see an exact address, a phone
        number, or to message someone. Browsing never needs one.
      </p>

      {/*
          Two buttons rather than a <select>, so both options are visible at once.
          Choosing an auth method from a dropdown hides the phone option on the
          phones where most of this audience is, and it is the option they want.
        */}
      <div className="segmented" role="tablist" aria-label="How to create an account">
        <button
          type="button"
          role="tab"
          aria-selected={method === 'email'}
          className={`segmented__btn ${method === 'email' ? 'is-active' : ''}`}
          onClick={() => setMethod('email')}
        >
          Email and password
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={method === 'otp'}
          className={`segmented__btn ${method === 'otp' ? 'is-active' : ''}`}
          onClick={() => setMethod('otp')}
        >
          Phone code
        </button>
      </div>

      <form className="auth__form" onSubmit={submit} noValidate>
        {method === 'email' ? (
          <>
            <div className="field">
              <label className="field__label" htmlFor="displayName">
                Your name
              </label>
              <input
                id="displayName"
                name="displayName"
                type="text"
                autoComplete="name"
                required
                className="field__input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                aria-describedby="displayName-hint"
              />
              {/*
                  The name is public on every listing you post. Saying so before the
                  field, rather than in a policy page, is the only point at which
                  the person can still decide not to use their real name.
                */}
              <p className="field__hint" id="displayName-hint">
                Shown on any property you list. Use the name you are happy to be
                contacted by.
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="reg-email">
                Email address
              </label>
              <input
                id="reg-email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                className="field__input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={error?.fields?.email ? true : undefined}
              />
              {error?.fields?.email ? (
                <p className="field__error">{error.fields.email}</p>
              ) : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="reg-password">
                Password
              </label>
              <input
                id="reg-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                className="field__input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby="password-rules"
                aria-invalid={error?.fields?.password ? true : undefined}
              />
              <ul className="rules" id="password-rules">
                {passwordRules.map((r) => (
                  <li key={r.label} className={r.ok ? 'is-met' : ''}>
                    {r.label}
                  </li>
                ))}
              </ul>
              {error?.fields?.password ? (
                <p className="field__error">{error.fields.password}</p>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label className="field__label" htmlFor="reg-phone">
                Phone number
              </label>
              <input
                id="reg-phone"
                name="phone"
                type="tel"
                autoComplete="tel"
                inputMode="tel"
                required
                placeholder="0803 123 4567"
                className="field__input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                aria-describedby="phone-hint"
              />
              <p className="field__hint" id="phone-hint">
                We send one code to confirm the number is yours. WhatsApp first,
                SMS if that does not arrive.
              </p>
            </div>

            {otpSent ? (
              <div className="field">
                <label className="field__label" htmlFor="reg-otp">
                  The 6-digit code
                </label>
                <input
                  id="reg-otp"
                  name="otp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  maxLength={6}
                  className="field__input"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                {error?.fields?.code || error?.fields?.otp ? (
                  <p className="field__error">
                    {error.fields.code ?? error.fields.otp}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        {notice ? (
          <p className="auth__notice" role="status">
            {notice}
          </p>
        ) : null}

        {error && !error.fields ? (
          <p className="auth__error" role="alert">
            {messageFor(error)}
          </p>
        ) : null}

        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy
            ? 'Working…'
            : method === 'otp'
              ? otpSent
                ? 'Confirm and create account'
                : 'Send me a code'
              : 'Create my account'}
        </button>

        {/*
          Google is offered on registration because the API creates the account
          on first sign-in from the verified Google email, so a person who
          registers this way never has to invent a password. It appears only for
          the email method: the OTP method is explicitly passwordless, so adding
          a third passwordless option above it would only muddy the choice.
        */}
        {method === 'email' ? <GoogleSignInButton next={next} /> : null}

        {method === 'otp' && otpSent ? (
          <button
            type="button"
            className="btn btn--ghost btn--block"
            onClick={sendOtp}
            disabled={sendingOtp}
          >
            {sendingOtp ? 'Sending…' : 'Send the code again'}
          </button>
        ) : null}
      </form>

      <div className="auth__alt">
        <p>
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
        <p className="auth__note">
          By joining you agree not to post a property you do not have the right to let or sell.
        </p>
      </div>
    </div>
  );
}

/**
 * The API returns `details` for contract violations; the form renders `fields`.
 * Mapping here keeps the two error shapes out of every call site.
 */
function withFieldMap(error: ApiError): ApiError {
  if (error.fields || !error.details) return error;
  const fields: Record<string, string> = {};
  for (const d of error.details) {
    if (d.path && !fields[d.path]) fields[d.path] = d.message;
  }
  return { ...error, fields };
}

function messageFor(error: ApiError): string {
  switch (error.code) {
    case 'EMAIL_ALREADY_REGISTERED':
      return 'There is already an account with that email. Sign in instead.';
    case 'PHONE_ALREADY_REGISTERED':
      return 'That number is already linked to an account. Sign in instead.';
    case 'WEAK_PASSWORD':
      return 'That password does not meet the rules listed above.';
    case 'INVALID_OTP':
      return 'That code is wrong or has expired. Ask for a new one.';
    case 'OTP_EXPIRED':
      return 'That code has expired. Ask for a new one.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return error.message ?? 'Could not create the account. Please try again.';
  }
}