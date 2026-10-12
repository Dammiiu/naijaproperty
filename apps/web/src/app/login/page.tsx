import { Suspense } from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getHeaderUser } from '@/lib/header';
import { SignInForm } from '@/components/sign-in-form';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to see exact addresses, contact owners and message them in-app.',
  // Sign-in pages must never appear in a search index.
  robots: { index: false, follow: true },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const user = await getHeaderUser();

  /*
   * Someone already signed in has no business on the sign-in page. Send them to
   * wherever they were originally headed, defaulting to their own listings, so
   * "List a property" works for a signed-in user who lands here by accident.
   *
   * The `startsWith('/')` check rejects an absolute URL: an open redirect here
   * would turn our own login page into a phishing hop.
   */
  if (user) {
    redirect(next && next.startsWith('/') ? next : '/dashboard');
  }

  return (
    <>
      <SiteHeader user={null} />
      <main id="main" className="container container--narrow">
        <Suspense>
          <SignInForm nextPath={next} />
        </Suspense>
      </main>
      <SiteFooter />
    </>
  );
}