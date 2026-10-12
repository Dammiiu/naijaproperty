'use client';

/**
 * Account menu.
 *
 * Replaces the sign-in and join buttons entirely once someone is signed in.
 * Showing a dimmed "Sign in" to a signed-in user is a small, constant reminder
 * that the header does not know who they are.
 *
 * Menu behaviour is hand-rolled rather than using <details> so the open state can
 * be closed on outside click and on Escape, both of which a native disclosure
 * leaves to the browser and handles inconsistently.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export function AccountMenu({ displayName, isStaff }: { displayName: string; isStaff: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      // Full navigation, so every server component re-renders without the
      // session. A client-side push would leave signed-out content on screen.
      window.location.assign('/');
    } catch {
      setSigningOut(false);
    }
  }

  // Initials rather than an avatar image: no upload surface for a glyph, and it
  // never renders as a broken image.
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="accountmenu" ref={wrap}>
      <button
        type="button"
        className="accountmenu__trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="accountmenu__avatar" aria-hidden="true">
          {initials || '?'}
        </span>
        <span className="accountmenu__name">{displayName}</span>
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" className="accountmenu__chev">
          <path fill="none" stroke="currentColor" strokeWidth="2.5" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div className="accountmenu__panel" role="menu">
          <p className="accountmenu__who">{displayName}</p>

          <Link href="/dashboard" role="menuitem" onClick={() => setOpen(false)}>
            <span>My listings</span>
            <span className="accountmenu__hint">Post, edit, track review</span>
          </Link>

          <Link href="/saved" role="menuitem" onClick={() => setOpen(false)}>
            <span>Saved searches</span>
            <span className="accountmenu__hint">Filters we keep watching</span>
          </Link>

          <Link href="/favourites" role="menuitem" onClick={() => setOpen(false)}>
            <span>Saved properties</span>
            <span className="accountmenu__hint">Shortlist for later</span>
          </Link>

          <Link href="/messages" role="menuitem" onClick={() => setOpen(false)}>
            <span>Messages</span>
            <span className="accountmenu__hint">Talk to owners in-app</span>
          </Link>

          {isStaff ? (
            <Link href="/admin" role="menuitem" onClick={() => setOpen(false)}>
              <span>Admin console</span>
              <span className="accountmenu__hint">Review queue and settings</span>
            </Link>
          ) : null}

          <button
            type="button"
            role="menuitem"
            className="accountmenu__signout"
            onClick={signOut}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}
    </div>
  );
}