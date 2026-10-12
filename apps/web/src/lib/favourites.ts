/**
 * Which of the given listings the viewer has shortlisted.
 *
 * One batched call rather than one request per card: a search page renders 24
 * results, and 24 round trips on a Nigerian mobile connection is the difference
 * between a page that appears and a page that seems broken.
 *
 * Returns an empty set for anonymous visitors rather than throwing. The shortlist
 * state is decorative when there is no session, and a failure here must not take
 * the browse page down with it.
 */

import { API_URL } from './constants';
import { getAccessToken } from './session';

export async function getFavourites(listingIds: string[]): Promise<Set<string>> {
  if (listingIds.length === 0) return new Set();

  try {
    const token = await getAccessToken();
    if (!token) return new Set();

    // Bounded to 100 to match the API's own cap.
    const qs = new URLSearchParams({ ids: listingIds.slice(0, 100).join(',') });

    const res = await fetch(`${API_URL}/api/v1/favourites/which?${qs.toString()}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return new Set();

    const body = (await res.json()) as { listingIds?: string[] };
    return new Set(body.listingIds ?? []);
  } catch {
    return new Set();
  }
}