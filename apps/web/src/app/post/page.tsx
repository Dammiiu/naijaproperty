import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getHeaderUser } from '@/lib/header';
import { PostPropertyForm, type PostFormOption } from '@/components/post-property-form';
import { getAllStates, getAreasForLga, getLgasForState, getTypesForKind } from '@/lib/locations';
import { getSessionUser } from '@/lib/session';
import { AMENITIES, type Amenity } from '@naijaproperty/contracts';
import {
  amenityHint as contractAmenityHint,
  amenityLabel as contractAmenityLabel,
} from '@naijaproperty/ui';

export const metadata: Metadata = {
  title: 'Post a property',
  description: 'List a property for rent or sale. Reviewed by our team before it goes live.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * "SECURITY_24H" becomes "24-hour power", from the contract vocabulary.
 *
 * This used to re-slugify the code locally, which was a third implementation of
 * the same mapping alongside the UI package's map and the contract's. They had
 * already drifted: the local one produced "Security 24h" while the facet said
 * something else. One vocabulary, one label.
 */
function amenityLabel(code: string): string {
  return contractAmenityLabel(code as Amenity);
}

function amenityHint(code: string): string {
  return contractAmenityHint(code as Amenity);
}

export default async function PostPropertyPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/post');

  const [states, rentTypes, saleTypes] = await Promise.all([
    getAllStates(),
    getTypesForKind('RENT'),
    getTypesForKind('SALE'),
  ]);

  /*
   * LGAs for every state in one request rather than 37. Areas are the genuinely
   * lazy part: they are fetched per LGA when the poster picks one, because
   * sending every area in Nigeria to a phone browser to populate one dropdown is
   * not a reasonable trade.
   */
  const lgams = await Promise.all(states.map((s) => getLgasForState(s.code)));
  const lgas = lgams.flat();

  const options: PostFormOption = {
    states,
    lgas,
    areas: [],
    rentTypes,
    saleTypes,
    // Labels and hints both come from the contract vocabulary, so a chip and the
    // filter facet beside it can never disagree about what a code means.
    amenities: AMENITIES.map((code) => ({ code, label: amenityLabel(code), hint: amenityHint(code) })),
  };

  return (
    <>
      <SiteHeader active="post" user={user ? { displayName: user.displayName, role: user.role, isStaff: false } : null} />
      <main id="main" className="container">
        <h1 className="post__title">Post a property</h1>
        <PostPropertyForm options={options} />
      </main>
      <SiteFooter />
    </>
  );
}