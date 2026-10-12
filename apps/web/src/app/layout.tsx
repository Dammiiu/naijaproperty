import type { Metadata, Viewport } from 'next';
import '@naijaproperty/ui/tokens.css';
import './globals.css';
import './components.css';
import './detail.css';
import './admin.css';
import './post.css';
import './dashboard.css';

import { webOrigin } from '@/lib/constants';

const siteName = process.env.NEXT_PUBLIC_SITE_NAME ?? 'Naijaproperty';
const description =
  'Buy and rent property across all 36 states and the FCT. Every listing is reviewed by our team before it goes live, with video walkthroughs and title verification.';

export const metadata: Metadata = {
  /*
   * Blank-safe on purpose.
   *
   * This was `new URL(process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000')`,
   * and `??` does not catch an empty string. A deploy where NEXT_PUBLIC_WEB_URL
   * is declared but blank produced `new URL('')`, which threw ERR_INVALID_URL
   * during `next build` and surfaced as the misleading "Failed to collect page
   * data for /_not-found" rather than as a configuration error.
   */
  metadataBase: new URL(webOrigin()),
  title: {
    default: `${siteName} | Property for Rent and Sale in Nigeria`,
    template: `%s | ${siteName}`,
  },
  description,
  openGraph: {
    type: 'website',
    siteName,
    locale: 'en_NG',
  },
  twitter: { card: 'summary_large_image' },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#10885a',
  width: 'device-width',
  initialScale: 1,
  // Cap the maximum zoom so a pinch gesture cannot push the filter bar into a
  // layout where the price inputs are unreachable on low-end Android.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG">
      <body>
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
