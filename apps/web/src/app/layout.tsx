import type { Metadata, Viewport } from 'next';
import '@naijaproperty/ui/tokens.css';
import './globals.css';
import './components.css';
import './detail.css';
import './admin.css';
import './post.css';
import './dashboard.css';

const siteName = process.env.NEXT_PUBLIC_SITE_NAME ?? 'Naijaproperty';
const description =
  'Buy and rent property across all 36 states and the FCT. Every listing is reviewed by our team before it goes live, with video walkthroughs and title verification.';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000'),
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
