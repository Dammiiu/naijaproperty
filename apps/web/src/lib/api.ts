/**
 * Server-side API access for Next.js.
 *
 * Runs on the server only, so the internal API URL never reaches the browser and
 * SSR is not subject to CORS. The refresh cookie is forwarded explicitly where
 * needed; public browse needs none.
 */

import type { ListingCard } from '@naijaproperty/contracts';
import { API_URL } from './constants';

export interface SearchParamsInput {
  kind: 'SALE' | 'RENT';
  q?: string;
  type?: string[];
  stateCode?: string[];
  pricePeriod?: string[];
  amenities?: string[];
  bedroomsMin?: number;
  minPrice?: number;
  maxPrice?: number;
  hasVideo?: boolean;
  hasVerifiedTitle?: boolean;
  verifiedOnly?: boolean;
  sort?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchResult {
  items: ListingCard[];
  nextCursor: string | null;
  totalEstimate: number;
  facets: Record<string, Array<{ code: string; label: string; count: number }>>;
}

/**
 * Public search.
 *
 * Returns an empty result rather than throwing when the API is unreachable, so a
 * transient API blip degrades to "no results" instead of a 500 page. An error
 * page for a browse request would be worse than an honest empty state.
 */
export async function searchListings(
  params: SearchParamsInput,
): Promise<SearchResult> {
  const qs = new URLSearchParams();
  qs.set('kind', params.kind);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || key === 'kind') continue;
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, String(v));
    } else {
      qs.set(key, String(value));
    }
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/search/listings?${qs.toString()}`, {
      headers: { accept: 'application/json' },
      // Search results change as listings are approved, so never cache a stale
      // count on the SEO surface.
      cache: 'no-store',
    });

    if (!res.ok) {
      console.error(`[search] API returned ${res.status} for ${qs.toString()}`);
      return { items: [], nextCursor: null, totalEstimate: 0, facets: {} };
    }

    return (await res.json()) as SearchResult;
  } catch (err) {
    console.error('[search] API unreachable:', (err as Error).message);
    return { items: [], nextCursor: null, totalEstimate: 0, facets: {} };
  }
}

export interface ListingDetail extends ListingCard {
  description: string;
  plotSqm: number | null;
  builtSqm: number | null;
  amenities: string[];
  dealType: string;
  priceNegotiable: boolean;
  paymentAdvance: number | null;
  agencyFee: number | null;
  minimumStayMonths: number | null;
  media: Array<{
    id: string;
    url: string | null;
    blurhash: string | null;
    dominantColor: string | null;
    isCover: boolean;
  }>;
  video: {
    streamUid: string;
    posterUrl: string | null;
    playbackHls: string | null;
    durationMs: number | null;
  } | null;
  poster: {
    displayName: string;
    verificationTier: string;
    memberSince: string;
    agencyName: string | null;
    agencyLicenceVerified: boolean;
  };
  /** Populated only for the owner or after reveal. */
  exactAddress: string | null;
  ownerPhone: string | null;
  conversationId: string | null;
  publishedAt: string;
  viewCount: number;
  contactClickCount: number;
  isOwner: boolean;
  contactRevealed: boolean;
}

export async function getListing(
  id: string,
  accessToken?: string | null,
): Promise<ListingDetail | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/listings/${id}`, {
      headers: {
        accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      cache: 'no-store',
    });

    if (!res.ok) return null;
    return (await res.json()) as ListingDetail;
  } catch (err) {
    console.error('[listing] API unreachable:', (err as Error).message);
    return null;
  }
}

/** States for the filter bar, rendered on first paint without an API round trip. */
export async function getStates(): Promise<Array<{ code: string; name: string }>> {
  try {
    const res = await fetch(`${API_URL}/api/v1/locations/states`, {
      headers: { accept: 'application/json' },
      // Reference data changes rarely; a short cache keeps the filter bar fast
      // without risking stale state codes.
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    return (await res.json()) as Array<{ code: string; name: string }>;
  } catch {
    return [];
  }
}

/**
 * Listing types for one kind.
 *
 * Kind-scoped on purpose. This is the list the filter bar renders, and it is the
 * exact place PropertyPro leaks: showing "Self Contain" under Sale, or "Land"
 * under Rent. The API enforces the split, so a wrong type cannot appear here.
 */
export async function getListingTypes(
  kind: 'RENT' | 'SALE',
): Promise<Array<{ code: string; label: string }>> {
  try {
    const res = await fetch(`${API_URL}/api/v1/locations/listing-types?kind=${kind}`, {
      headers: { accept: 'application/json' },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { types?: Array<{ code: string; label: string }> };
    return body.types ?? (body as unknown as Array<{ code: string; label: string }>);
  } catch {
    return [];
  }
}
