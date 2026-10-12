'use client';

/**
 * Similar listings carousel.
 *
 * Fetches up to 5 similar listings from the same area/LGA/state and displays
 * them in a horizontal scroll container. Uses the same ListingCard component
 * as search results so the visual language is consistent.
 */

import { Suspense, useEffect, useState } from 'react';
import { ListingCardView } from '@/components/listing-card';
import { API_URL } from '@/lib/constants';
import type { ListingCard } from '@naijaproperty/contracts';

/**
 * Cache of in-flight promises so the same listingId reuses the request
 * across renders and across Suspense boundaries.
 */
const fetchCache = new Map<string, Promise<{ items: ListingCard[] }>>();

function getBaseUrl(): string {
  // On the server, we need an absolute URL. On the client, relative works.
  if (typeof window === 'undefined') {
    // Blank-safe: reuses API_URL rather than repeating the `??` chain, which
    // does not fall back when the variable is set to an empty string.
    return API_URL;
  }
  // Client-side: relative URL works
  return '';
}

function fetchSimilar(listingId: string): Promise<{ items: ListingCard[] }> {
  let promise = fetchCache.get(listingId);
  if (!promise) {
    promise = (async () => {
      const baseUrl = getBaseUrl();
      const url = baseUrl
        ? `${baseUrl}/api/v1/listings/${listingId}/similar`
        : `/api/listings/${listingId}/similar`;
      const res = await fetch(url, {
        cache: 'no-store',
      });
      if (!res.ok) return { items: [] as ListingCard[] };
      return res.json() as Promise<{ items: ListingCard[] }>;
    })();
    fetchCache.set(listingId, promise);
  }
  return promise;
}

function SimilarListingsContent({ listingId }: { listingId: string }) {
  const [items, setItems] = useState<ListingCard[] | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    let cancelled = false;
    const promise = fetchSimilar(listingId);
    promise.then((data) => {
      if (!cancelled) {
        setItems(data.items);
      }
    }).catch((err) => {
      console.error('[SimilarListings] fetchSimilar failed:', err);
      if (!cancelled) setItems([]);
    });
    return () => {
      cancelled = true;
    };
  }, [listingId]);

  // Show skeleton while loading (before mount and while fetching)
  if (!mounted || items === null) {
    return <div className="similar__skeleton" />;
  }

  // No results
  if (items.length === 0) return null;

  return (
    <section className="similar" aria-labelledby="similar-heading">
      <div className="similar__header">
        <h2 id="similar-heading" className="similar__title">
          Similar properties in the area
        </h2>
      </div>
      <div className="similar__scroll" role="list">
        {items.map((item) => (
          <article key={item.id} className="similar__item" role="listitem">
            <ListingCardView listing={item} />
          </article>
        ))}
      </div>
    </section>
  );
}

export function SimilarListings({ listingId }: { listingId: string }) {
  return <SimilarListingsContent listingId={listingId} />;
}