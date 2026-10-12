/**
 * Cascading location pickers for the post form.
 *
 * State → LGA → area, fetched on demand rather than all at once. The country has
 * 774 LGAs and thousands of areas; shipping the whole tree to a browser to render
 * three dropdowns would be wasteful and slow on the mobile connections most
 * posters use.
 *
 * Areas are only fetched once an LGA is chosen, and each response is cached in
 * sessionStorage for the life of the tab, a poster who goes back to fix a typo
 * should not refetch the list they already have.
 */

import 'server-only';
import { apiFetch } from './session';
import { API_URL } from '@/lib/constants';
import type { ListingKind } from '@naijaproperty/contracts';

export interface StateOption {
  code: string;
  name: string;
}

export interface LgaOption {
  id: string;
  code: string;
  name: string;
  stateCode: string;
}

export interface AreaOption {
  id: string;
  name: string;
  lgaId: string;
  isActive: boolean;
}

/** States change rarely; cached for an hour across requests. */
export async function getAllStates(): Promise<StateOption[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/locations/states`, {
      headers: { accept: 'application/json' },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    return (await res.json()) as StateOption[];
  } catch {
    return [];
  }
}

export async function getLgasForState(stateCode: string): Promise<LgaOption[]> {
  if (!/^[A-Z]{2}$/.test(stateCode)) return [];
  return (
    (await apiFetch<LgaOption[]>(`/api/v1/locations/lgas?stateCode=${stateCode}`, {
      auth: false,
    })) ?? []
  );
}

/**
 * Areas within an LGA.
 *
 * Returns inactive areas as well, because a poster who previously proposed one
 * must still be able to file against it. The form marks them so the poster knows
 * an admin has yet to activate it.
 */
export async function getAreasForLga(lgaId: string): Promise<AreaOption[]> {
  if (!lgaId) return [];

  try {
    const res = await fetch(`${API_URL}/api/v1/locations/areas?lgaId=${lgaId}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const body = (await res.json()) as { areas?: AreaOption[] } | AreaOption[];
    return Array.isArray(body) ? body : (body.areas ?? []);
  } catch {
    return [];
  }
}

/** Kind-scoped type list, which is what keeps rent and sale taxonomies disjoint. */
export async function getTypesForKind(kind: ListingKind): Promise<Array<{ code: string; label: string }>> {
  try {
    const res = await fetch(`${API_URL}/api/v1/locations/listing-types?kind=${kind}`, {
      headers: { accept: 'application/json' },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { types?: Array<{ code: string; label: string }> } | Array<{
      code: string;
      label: string;
    }>;
    return Array.isArray(body) ? body : (body.types ?? []);
  } catch {
    return [];
  }
}