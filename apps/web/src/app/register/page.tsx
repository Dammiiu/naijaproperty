import { Suspense } from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getHeaderUser } from '@/lib/header';
import { RegisterForm } from '@/components/register-form';

export const metadata: Metadata = {
  title: 'Join free',
  description:
    'Create a free account to see exact addresses, contact owners directly and message them in-app.',
  robots: { index: true, follow: true },
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const user = await getHeaderUser();

  // Someone who already has an account has no use for this page, and leaving them
  // here invites them to create a second one.
  if (user) {
    redirect(next && next.startsWith('/') ? next : '/dashboard');
  }

  return (
    <>
      <SiteHeader user={null} />
      <main id="main" className="container container--narrow">
        <Suspense>
          <RegisterForm nextPath={next} />
        </Suspense>
      </main>
      <SiteFooter />
    </>
  );
}