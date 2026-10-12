/**
 * Root toggle between Sale and Rent.
 *
 * This is the structural difference from the market: the toggle is not a
 * filter chip sitting among others, it is the top-level partition. It changes
 * the URL, swaps the entire facet set, and is rendered as a segmented control
 * so the current partition is unambiguous before any interaction.
 */

'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';
import type { ListingKind } from '@naijaproperty/contracts';
import { kindLabel } from '@naijaproperty/ui';

const KINDS: Array<{ value: ListingKind; label: string; hint: string }> = [
  { value: 'RENT', label: 'Rent', hint: 'Homes, rooms and offices available to rent' },
  { value: 'SALE', label: 'Buy', hint: 'Property for sale and land' },
];

export function KindToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const current = (params.get('kind') ?? 'RENT') as ListingKind;

  const onChange = useCallback(
    (kind: ListingKind) => {
      const next = new URLSearchParams(params.toString());
      next.set('kind', kind);

      // Type, price period and deed filters do not carry across the partition.
      // Leaving them set is exactly how a rent search starts returning sales.
      for (const key of ['type', 'pricePeriod', 'deedType']) next.delete(key);

      router.push(`${pathname}?${next.toString()}`);
    },
    [params, pathname, router],
  );

  return (
    <div
      role="radiogroup"
      aria-label="Listing type"
      className="kind-toggle"
    >
      {KINDS.map((k) => {
        const selected = current === k.value;
        return (
          <button
            key={k.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={k.hint}
            className="kind-toggle__option"
            data-selected={selected}
            onClick={() => onChange(k.value)}
          >
            {k.label}
            <span className="visually-hidden">
              {selected ? ' (current)' : ''} {k.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}
