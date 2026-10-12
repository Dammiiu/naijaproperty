/**
 * Filter bar.
 *
 * Two deliberate departures from the observed market:
 *  1. Price uses real numeric range inputs with log-scaled suggestions. The
 *     incumbent's hardcoded select ladder (50k/100k/200k ... 1m/2m/3m) makes a
 *     N7.5M budget unselectable.
 *  2. Rent payment period is a first-class control, not normalised away to
 *     "/year", because pay-2-years-upfront drives Nigerian rentals.
 */

'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ListingKind } from '@naijaproperty/contracts';
import { formatNaira, priceStepSuggestions } from '@naijaproperty/ui';
import { KindToggle } from './kind-toggle';

const PRICE_STEPS = priceStepSuggestions(12);

const RENT_PERIODS = [
  { value: 'YEARLY', label: 'Yearly' },
  { value: 'TWO_YEARLY', label: '2 years' },
  { value: 'MONTHLY', label: 'Monthly' },
];

interface TypeOption {
  code: string;
  label: string;
}

export function FilterBar({
  kind,
  types,
  states,
}: {
  kind: ListingKind;
  types: TypeOption[];
  states: Array<{ code: string; name: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [minPrice, setMinPrice] = useState(params.get('minPrice') ?? '');
  const [maxPrice, setMaxPrice] = useState(params.get('maxPrice') ?? '');
  const [query, setQuery] = useState(params.get('q') ?? '');

  useEffect(() => {
    setMinPrice(params.get('minPrice') ?? '');
    setMaxPrice(params.get('maxPrice') ?? '');
    setQuery(params.get('q') ?? '');
  }, [params]);

  const push = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(params.toString());
      mutate(next);
      startTransition(() => {
        router.push(`${pathname}?${next.toString()}`);
      });
    },
    [params, pathname, router],
  );

  const applyPrices = useCallback(() => {
    push((next) => {
      if (minPrice) next.set('minPrice', minPrice);
      else next.delete('minPrice');
      if (maxPrice) next.set('maxPrice', maxPrice);
      else next.delete('maxPrice');
    });
  }, [minPrice, maxPrice, push]);

  const toggleParam = useCallback(
    (key: string, value: string) => {
      push((next) => {
        const current = next.getAll(key);
        if (current.includes(value)) {
          next.delete(key);
          for (const v of current) {
            if (v !== value) next.append(key, v);
          }
        } else {
          next.append(key, value);
        }
      });
    },
    [push],
  );

  const isSet = (key: string, value: string) => params.getAll(key).includes(value);

  return (
    <section className="filters" aria-label="Search filters" data-pending={pending}>
      <div className="filters__row filters__row--primary">
        <form
          className="filters__search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            push((next) => {
              if (query) next.set('q', query);
              else next.delete('q');
            });
          }}
        >
          <label className="visually-hidden" htmlFor="listing-search">
            Search by area, neighbourhood or keyword
          </label>
          <input
            id="listing-search"
            type="search"
            className="filters__input"
            placeholder="Search an area, estate or keyword"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            enterKeyHint="search"
          />
          <button type="submit" className="filters__submit">
            Search
          </button>
        </form>

        <KindToggle />
      </div>

      <div className="filters__row">
        <fieldset className="filters__fieldset filters__fieldset--price">
          <legend className="filters__legend">Price range ({'₦'})</legend>

          <div className="filters__range">
            <div className="filters__range-field">
              <label className="visually-hidden" htmlFor="min-price">
                Minimum price in naira
              </label>
              <input
                id="min-price"
                type="number"
                inputMode="numeric"
                min={0}
                step={50_000}
                list="price-steps"
                className="filters__input filters__input--num"
                placeholder="Min"
                value={minPrice}
                onChange={(e) => setMinPrice(e.target.value)}
                onBlur={applyPrices}
              />
              <span aria-hidden="true">–</span>
              <label className="visually-hidden" htmlFor="max-price">
                Maximum price in naira
              </label>
              <input
                id="max-price"
                type="number"
                inputMode="numeric"
                min={0}
                step={50_000}
                list="price-steps"
                className="filters__input filters__input--num"
                placeholder="Max"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                onBlur={applyPrices}
              />
            </div>

            {/* Log-scaled suggestions so the whole N50k to N2bn span is
                reachable, which the fixed select ladder does not achieve. */}
            <datalist id="price-steps">
              {PRICE_STEPS.map((step) => (
                <option key={step} value={step}>
                  {formatNaira(step)}
                </option>
              ))}
            </datalist>

            {params.get('minPrice') || params.get('maxPrice') ? (
              <button
                type="button"
                className="filters__clear"
                onClick={() =>
                  push((next) => {
                    next.delete('minPrice');
                    next.delete('maxPrice');
                  })
                }
              >
                Clear price
              </button>
            ) : null}
          </div>
        </fieldset>

        {kind === 'RENT' ? (
          <fieldset className="filters__fieldset">
            <legend className="filters__legend">Rent period</legend>
            <div className="chips">
              {RENT_PERIODS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className="chip"
                  aria-pressed={isSet('pricePeriod', p.value)}
                  onClick={() => toggleParam('pricePeriod', p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </fieldset>
        ) : (
          <fieldset className="filters__fieldset">
            <legend className="filters__legend">Property type</legend>
            <div className="chips">
              {types.map((t) => (
                <button
                  key={t.code}
                  type="button"
                  className="chip"
                  aria-pressed={isSet('type', t.code)}
                  onClick={() => toggleParam('type', t.code)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </fieldset>
        )}
      </div>

      <details className="filters__more">
        <summary>More filters (state, bedrooms, verified only)</summary>
        <div className="filters__row">
          <fieldset className="filters__fieldset">
            <legend className="filters__legend">State</legend>
            <div className="chips chips--scroll">
              {states.map((s) => (
                <button
                  key={s.code}
                  type="button"
                  className="chip"
                  aria-pressed={isSet('stateCode', s.code)}
                  onClick={() => toggleParam('stateCode', s.code)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="filters__fieldset">
            <legend className="filters__legend">Minimum bedrooms</legend>
            <div className="chips">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className="chip"
                  aria-pressed={params.get('bedroomsMin') === String(n)}
                  onClick={() =>
                    push((next) => {
                      if (params.get('bedroomsMin') === String(n)) next.delete('bedroomsMin');
                      else next.set('bedroomsMin', String(n));
                    })
                  }
                >
                  {n}+
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="filters__fieldset">
            <legend className="filters__legend">Trust</legend>
            <div className="chips">
              <button
                type="button"
                className="chip"
                aria-pressed={params.get('verifiedOnly') === 'true'}
                onClick={() =>
                  push((next) => {
                    if (next.get('verifiedOnly') === 'true') next.delete('verifiedOnly');
                    else next.set('verifiedOnly', 'true');
                  })
                }
              >
                Verified owner only
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={params.get('hasVideo') === 'true'}
                onClick={() =>
                  push((next) => {
                    if (next.get('hasVideo') === 'true') next.delete('hasVideo');
                    else next.set('hasVideo', 'true');
                  })
                }
              >
                Has video tour
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={params.get('hasVerifiedTitle') === 'true'}
                onClick={() =>
                  push((next) => {
                    if (next.get('hasVerifiedTitle') === 'true') next.delete('hasVerifiedTitle');
                    else next.set('hasVerifiedTitle', 'true');
                  })
                }
              >
                Title checked
              </button>
            </div>
          </fieldset>
        </div>
      </details>
    </section>
  );
}
