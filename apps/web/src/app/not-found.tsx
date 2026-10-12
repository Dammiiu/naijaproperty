import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';

/**
 * Not found.
 *
 * Deliberately indistinguishable for a listing that does not exist and a listing
 * that is not live. A distinct "this listing is under review" page would confirm
 * to a scraper that a given id exists, which is worth more than the help it gives
 * to a legitimate owner.
 */
export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="container notfound">
        <p className="notfound__code">Not found</p>
        <h1 className="notfound__title">We could not find that page</h1>
        <p className="notfound__body">
          The listing may have been taken down by its owner, may still be going through review, or
          the link may be wrong. Properties that are still under review never appear publicly.
        </p>
        <p>
          <Link className="btn btn--primary" href="/">
            Back to search
          </Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}