'use client';

/**
 * Post-a-property form.
 *
 * Structured as discrete steps rather than one long page because posting a
 * property is a long task with photos, and a single scrolling form on a phone
 * loses the user's place every time a validation error scrolls them back up.
 * Each step is independently validatable, so progress is never lost.
 *
 * Step order follows what the poster already knows: what it is, where it is,
 * what it is like, what it costs, what it looks like, then a review. The photo
 * step comes late deliberately, it is the most expensive part of the task and
 * the one most likely to be abandoned, so it is not asked for until everything
 * cheap has been captured.
 *
 * Photos upload straight to R2 from the browser. The bytes never pass through
 * Next.js or the API, so a slow upload does not tie up an application server.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatNaira } from '@naijaproperty/ui';
import type { ListingKind } from '@naijaproperty/contracts';
import { VideoUpload } from './video-upload';

export interface PostFormOption {
  states: Array<{ code: string; name: string }>;
  lgas: Array<{ id: string; code: string; name: string; stateCode: string }>;
  areas: Array<{
    id: string;
    name: string;
    lgaId: string;
    isActive: boolean;
    proposalCount?: number;
  }>;
  rentTypes: Array<{ code: string; label: string }>;
  saleTypes: Array<{ code: string; label: string }>;
  amenities: Array<{ code: string; label: string; hint?: string }>;
}

type Photo = {
  /** Local object URL for preview; revoked once the upload finishes. */
  preview: string;
  file: File;
  state: 'uploading' | 'processing' | 'ready' | 'failed';
  assetId?: string;
  error?: string;
  progress: number;
};

const STEPS = ['What are you listing', 'Where it is', 'The details', 'Price', 'Photos', 'Review'] as const;

/** Contract field name to something a person can act on. */
const FIELD_LABELS: Record<string, string> = {
  mediaAssetIds: 'Photos',
  exactAddress: 'Exact address',
  title: 'Title',
  description: 'Description',
  price: 'Price',
  pricePeriod: 'Payment period',
  priceNegotiable: 'Price',
  bedrooms: 'Bedrooms',
  bathrooms: 'Bathrooms',
  plotSqm: 'Plot size',
  builtSqm: 'Built area',
  amenities: 'Features',
  deedType: 'Title document',
  type: 'Property type',
  stateCode: 'State',
  lgaCode: 'Local government area',
  areaId: 'Area',
  paymentAdvance: 'Advance',
  minimumStayMonths: 'Minimum stay',
  agencyFee: 'Agency fee',
};

/**
 * Which step owns each field. Used to send the user back to the screen that can
 * actually fix the problem, instead of leaving them on Review with a message
 * about a step they already passed.
 */
const STEP_FOR_FIELD: Record<string, number> = {
  type: 0,
  stateCode: 1,
  lgaCode: 1,
  areaId: 1,
  title: 2,
  description: 2,
  plotSqm: 2,
  builtSqm: 2,
  amenities: 2,
  deedType: 2,
  price: 3,
  pricePeriod: 3,
  priceNegotiable: 3,
  exactAddress: 3,
  paymentAdvance: 3,
  mediaAssetIds: 4,
};

/** The contract requires at least five photos before a listing can be created. */
const MIN_PHOTOS = 5;
const MAX_PHOTOS = 20;

export function PostPropertyForm({ options }: { options: PostFormOption }) {
  const router = useRouter();
  const [step, setStep] = useState(0);

  // --- kind, location
  const [kind, setKind] = useState<ListingKind>('RENT');
  const [type, setType] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [lgaId, setLgaId] = useState('');
  const [areaId, setAreaId] = useState('');

  /*
   * Free-text location capture.
   *
   * Kept as separate state rather than folded into `lgaId`/`areaId` because they
   * mean different things: those hold ids that already exist, these hold names that
   * do not yet. Folding them together would mean guessing, at submit time, whether
   * a value is an id or a name, and that guess is exactly the kind that silently
   * files a listing against the wrong place.
   */
  const [namingLga, setNamingLga] = useState(false);
  const [newLgaName, setNewLgaName] = useState('');
  const [newAreaName, setNewAreaName] = useState('');
  /** Whether the area control is the select or the free-text box. */
  const [useAreaText, setUseAreaText] = useState(false);
  /** Set only once Cloudflare confirms the video is playable, never on upload alone. */
  const [videoAssetId, setVideoAssetId] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);

  // A changed LGA invalidates the area list, so the area returns to the select.
  // Left in the text box it would show a name typed against the previous LGA and
  // quietly propose it in the wrong place.
  useEffect(() => {
    setUseAreaText(false);
  }, [lgaId]);

  /*
   * Typing an LGA means there is no id to list areas against, so the area control
   * has to be free text too. Without this the area select stays disabled with the
   * note "Choose an LGA first" while the poster is visibly in the middle of
   * choosing one, which reads as a broken form.
   */
  useEffect(() => {
    if (namingLga) setUseAreaText(true);
  }, [namingLga]);

  // --- details
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [bedrooms, setBedrooms] = useState<string>('');
  const [bathrooms, setBathrooms] = useState<string>('');
  const [plotSqm, setPlotSqm] = useState<string>('');
  const [builtSqm, setBuiltSqm] = useState<string>('');
  const [amenityCodes, setAmenityCodes] = useState<string[]>([]);
  const [deedType, setDeedType] = useState('NONE');

  // --- price
  const [price, setPrice] = useState<string>('');
  const [pricePeriod, setPricePeriod] = useState<'MONTHLY' | 'YEARLY' | 'TWO_YEARLY' | ''>('YEARLY');
  const [paymentAdvance, setPaymentAdvance] = useState<string>('');
  const [negotiable, setNegotiable] = useState(false);
  const [exactAddress, setExactAddress] = useState('');

  // --- media
  const [photos, setPhotos] = useState<Photo[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  // --- submission
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const types = kind === 'SALE' ? options.saleTypes : options.rentTypes;
  const lgasForState = useMemo(
    () => options.lgas.filter((l) => l.stateCode === stateCode),
    [options.lgas, stateCode],
  );

  /*
   * Areas load per LGA, on demand. They cannot be part of the server payload:
   * there are thousands of areas across Nigeria, and shipping all of them so one
   * dropdown can be populated is not a reasonable trade on a mobile connection.
   */
  const [areas, setAreas] = useState<PostFormOption['areas']>(options.areas);
  const [areasLoading, setAreasLoading] = useState(false);

  useEffect(() => {
    if (!lgaId) {
      setAreas(options.areas);
      return;
    }

    const cacheKey = `njp-areas:${lgaId}`;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      setAreas(JSON.parse(cached) as PostFormOption['areas']);
      return;
    }

    let cancelled = false;
    setAreasLoading(true);

    fetch(`/api/post/areas?lgaId=${lgaId}`)
      .then((r) => r.json())
      .then((body: { areas?: PostFormOption['areas'] }) => {
        if (cancelled || !body.areas) return;
        setAreas(body.areas);
        sessionStorage.setItem(cacheKey, JSON.stringify(body.areas));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAreasLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [lgaId, options.areas]);

  const areasForLga = useMemo(() => areas.filter((a) => a.lgaId === lgaId), [areas, lgaId]);
  const isLand = type === 'LAND' || type === 'LAND_LEASE';

  // Changing the kind invalidates the type, because the taxonomies are disjoint.
  // A bungalow is legal in both, but a self-contain is not a sale type at all.
  const changeKind = useCallback((next: ListingKind) => {
    setKind(next);
    setType('');
    if (next === 'SALE') setPricePeriod('');
    else if (!pricePeriod) setPricePeriod('YEARLY');
  }, [pricePeriod]);

  const toggleAmenity = (code: string) =>
    setAmenityCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  // -------------------------------------------------------------------------
  // Photo upload
  // -------------------------------------------------------------------------

  const uploadOne = useCallback(async (file: File, index: number) => {
    const patch = (next: Partial<Photo>) =>
      setPhotos((prev) => prev.map((p, i) => (i === index ? { ...p, ...next } : p)));

    patch({ state: 'uploading', progress: 0 });

    try {
      const presignRes = await fetch('/api/post/media', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'presign',
          kind: 'image',
          fileName: file.name,
          contentType: file.type,
          bytes: file.size,
        }),
      });
      const presign = (await presignRes.json()) as {
        assetId?: string;
        uploadUrl?: string;
        headers?: Record<string, string>;
        error?: { message?: string };
      };

      if (!presignRes.ok || !presign.uploadUrl || !presign.assetId) {
        patch({ state: 'failed', error: presign.error?.message ?? 'Could not start the upload' });
        return;
      }

      /*
       * Straight to R2. The presigned URL covers a single PUT and carries its own
       * signature, so this request needs no credentials of ours, which is the
       * entire reason bytes never touch the API.
       *
       * XHR rather than fetch: upload progress is the one thing fetch still
       * cannot report, and a photo upload with no progress bar on a Nigerian
       * mobile connection feels like it has hung.
       */
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', presign.uploadUrl!);
        for (const [name, value] of Object.entries(presign.headers ?? {})) {
          xhr.setRequestHeader(name, value);
        }
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) patch({ progress: Math.round((e.loaded / e.total) * 100) });
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`R2 rejected the upload (HTTP ${xhr.status})`));
        xhr.onerror = () =>
          /*
           * A CORS rejection reaches the page as an opaque network error, the
           * browser deliberately hides the reason, and XHR exposes no status. So
           * this is the most likely cause by a wide margin: the bucket has no
           * CORS policy allowing this origin, which is a one-time dashboard
           * setting rather than a code fault. Saying so saves the poster from
           * retrying a button that can never work.
           */
          reject(
            new Error(
              'Upload blocked by the browser. The photo storage bucket needs a CORS rule allowing this site to upload. See docs/cloudflare-setup.md.',
            ),
          );
        xhr.send(file);
      });

      patch({ state: 'processing', progress: 100 });

      // Content hash enables per-owner dedupe, so an agency re-uploading the same
      // photo across twenty listings stores one copy.
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const contentHash = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      for (const action of ['complete', 'process'] as const) {
        const res = await fetch('/api/post/media', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, assetId: presign.assetId, contentHash }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(body?.error?.message ?? `Upload ${action} failed`);
        }
      }

      patch({ state: 'ready', assetId: presign.assetId });
    } catch (err) {
      patch({ state: 'failed', error: (err as Error).message });
    }
  }, []);

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!files) return;

      const room = MAX_PHOTOS - photos.length;
      const accepted = Array.from(files)
        .filter((f) => f.type.startsWith('image/'))
        .slice(0, Math.max(room, 0));

      if (accepted.length === 0) return;

      const startIndex = photos.length;
      const withPreviews: Photo[] = accepted.map((file) => ({
        preview: URL.createObjectURL(file),
        file,
        state: 'uploading',
        progress: 0,
      }));
      setPhotos((prev) => [...prev, ...withPreviews]);

      // Sequential rather than parallel: a phone on a congested network uploads
      // several photos at once far more slowly than one after another, and
      // parallel PUTs all stall together.
      for (let i = 0; i < accepted.length; i += 1) {
        await uploadOne(accepted[i], startIndex + i);
      }
    },
    [photos.length, uploadOne],
  );

  const removePhoto = (index: number) => {
    URL.revokeObjectURL(photos[index].preview);
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  };

  const makeCover = (index: number) =>
    setPhotos((prev) => {
      const next = [...prev];
      const [picked] = next.splice(index, 1);
      next.unshift(picked);
      return next;
    });

  // -------------------------------------------------------------------------
  // Validation, per step
  // -------------------------------------------------------------------------

  function validateStep(index: number): Record<string, string> {
    const errors: Record<string, string> = {};

    if (index === 0 && !type) errors.type = 'Choose what you are listing';
    if (index === 1) {
      if (!stateCode) errors.stateCode = 'Choose a state';
      // An LGA is required either way, but a typed name counts: refusing the
      // listing is how a landlord outside our reference data ends up posting on a
      // classifieds site instead.
      if (!lgaId && !newLgaName.trim()) {
        errors.lgaId = namingLga
          ? 'Type the local government area name'
          : 'Choose the local government area';
      }
    }
    if (index === 2) {
      if (title.trim().length < 10) errors.title = 'Give your listing a clearer title (at least 10 characters)';
      if (description.trim().length < 60)
        errors.description = `Describe the property in at least 60 characters. You have written ${description.trim().length}`;
      if (isLand && !plotSqm) errors.plotSqm = 'Land listings need a plot size';
      if (isLand && deedType === 'NONE') errors.deedType = 'Land listings must declare a title type';
      /*
         Selling needs a stated title; letting does not.

         A buyer is handing over life savings against a piece of paper, so silence
         is not an option there. A renter has no stake in the deed, and demanding
         one would lock out exactly the ordinary landlords this platform is for.
         `SUBJECT_TO` is the honest answer for a sale still being documented, so
         nobody is pushed into claiming a title they do not hold.
        */
      if (kind === 'SALE' && deedType === 'NONE') {
        errors.deedType = 'Tell us what title you hold, or choose "Sale is subject to documentation"';
      }
    }
    if (index === 3) {
      if (!price || Number(price) <= 0) errors.price = 'Enter the price in naira';
      if (kind === 'RENT' && !pricePeriod) errors.pricePeriod = 'Choose how often rent is paid';
      if (exactAddress.trim().length < 5)
        errors.exactAddress = 'Give the exact address. Only signed-in viewers will ever see it';
    }
    if (index === 4) {
      const ready = photos.filter((p) => p.state === 'ready').length;
      if (ready < MIN_PHOTOS) errors.photos = `Upload at least ${MIN_PHOTOS} photos. ${ready} ready so far`;
      if (photos.some((p) => p.state === 'uploading' || p.state === 'processing'))
        errors.photos = 'Wait for the uploads to finish';
    }

    return errors;
  }

  function next() {
    const errors = validateStep(step);
    setFieldErrors(errors);
    if (Object.keys(errors).length === 0) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function back() {
    setFieldErrors({});
    setStep((s) => Math.max(s - 1, 0));
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  async function submit() {
    // Re-validate every step, not just the review one, so a stale earlier step
    // cannot slip through.
    for (let i = 0; i < 5; i += 1) {
      const errors = validateStep(i);
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        setStep(i);
        setSubmitError({ message: 'Something above still needs fixing.' });
        return;
      }
    }

    setSubmitting(true);
    setSubmitError(null);
    setProposalError(null);

    try {
      /*
       * Resolve the typed LGA before posting the listing.
       *
       * Order matters. The listing needs an LGA code, and a typed name is not one,
       * so the proposal has to land first and hand back a code. Doing it the other
       * way round would mean posting a listing with no location and then trying to
       * patch it, which is how half-filled rows get left in search.
       *
       * A failure here is fatal to the submit rather than skipped. Falling through
       * with no LGA would produce exactly the listing with no location we are trying
       * to avoid, and it would look like success.
       */
      let resolvedLgaCode = options.lgas.find((l) => l.id === lgaId)?.code;
      let resolvedAreaId = areaId || undefined;

      if (!resolvedLgaCode && newLgaName.trim()) {
        const lgaRes = await fetch('/api/post/lgas/propose', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: newLgaName.trim(), stateCode }),
        });
        const lgaBody = (await lgaRes.json().catch(() => null)) as {
          code?: string;
          error?: { message?: string };
        } | null;

        if (!lgaRes.ok || !lgaBody?.code) {
          setProposalError(
            lgaBody?.error?.message ?? 'Could not add that local government area.',
          );
          setStep(1);
          return;
        }
        resolvedLgaCode = lgaBody.code;

        // The area hangs off the LGA, so it can only be proposed once the LGA
        // exists. Best effort: a missing area degrades the listing's searchability
        // but does not block it, and the review queue can attach one.
        if (newAreaName.trim()) {
          const areaRes = await fetch('/api/post/areas', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: newAreaName.trim(),
              lgaCode: resolvedLgaCode,
            }),
          });
          const areaBody = (await areaRes.json().catch(() => null)) as { id?: string } | null;
          resolvedAreaId = areaBody?.id ?? undefined;
        }
      } else if (newAreaName.trim() && !areaId) {
        // Area typed under an LGA that already exists.
        const areaRes = await fetch('/api/post/areas', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: newAreaName.trim(), lgaCode: resolvedLgaCode }),
        });
        const areaBody = (await areaRes.json().catch(() => null)) as { id?: string } | null;
        resolvedAreaId = areaBody?.id ?? undefined;
      }

      const res = await fetch('/api/post/listings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          type,
          stateCode,
          lgaCode: resolvedLgaCode,
          areaId: resolvedAreaId,
          exactAddress: exactAddress.trim(),
          title: title.trim(),
          description: description.trim(),
          price: Number(price),
          pricePeriod: kind === 'RENT' ? pricePeriod : 'NONE',
          priceNegotiable: negotiable,
          paymentAdvance: paymentAdvance ? Number(paymentAdvance) : null,
          bedrooms: bedrooms ? Number(bedrooms) : null,
          bathrooms: bathrooms ? Number(bathrooms) : null,
          plotSqm: plotSqm ? Number(plotSqm) : null,
          builtSqm: builtSqm ? Number(builtSqm) : null,
          amenities: amenityCodes,
          deedType,
          mediaAssetIds: photos.filter((p) => p.assetId).map((p) => p.assetId!),
          // Only sent once the video is genuinely playable. A listing that references
          // an asset still encoding would publish a player that cannot load.
          ...(videoAssetId ? { videoAssetId } : {}),
        }),
      });

      const body = (await res.json()) as {
        listingId?: string;
        error?: { code?: string; message?: string; details?: Array<{ path: string; message: string }> };
      };

      if (!res.ok) {
        const fields: Record<string, string> = {};
        for (const d of body.error?.details ?? []) fields[d.path] = d.message;
        setFieldErrors(fields);

        /*
         * The API's top-level message for a validation failure is deliberately
         * generic ("Check the highlighted fields") because a single message has
         * to cover every possible field. On a step-per-screen form that is
         * useless: the user cannot see which field is highlighted, so they are
         * sent back with no idea what to fix. Naming the field is the whole
         * difference between a fixable message and a dead end.
         */
        const named = Object.entries(fields);
        const message =
          named.length === 1
            ? `${FIELD_LABELS[named[0][0]] ?? named[0][0]}: ${named[0][1]}`
            : named.length > 1
              ? `${named.length} fields need attention: ${named
                  .map(([k, v]) => `${FIELD_LABELS[k] ?? k} (${v})`)
                  .join(', ')}`
              : (body.error?.message ?? 'Could not submit the listing');

        setSubmitError({ message, fields });

        // Send the user to the step that owns the first failing field rather than
        // leaving them on the review screen with a message about an earlier step.
        const firstBad = named[0]?.[0];
        if (firstBad) {
          const stepFor = STEP_FOR_FIELD[firstBad];
          if (stepFor !== undefined && stepFor !== step) setStep(stepFor);
        }
        return;
      }

      // A draft means the listing exists but did not enter review. Say so, and
      // send them to the dashboard rather than pretending it worked.
      if (body.error?.code === 'SUBMIT_FAILED') {
        setSubmitError({
          message: `${body.error.message} Your listing is saved, so open your dashboard to submit it again.`,
        });
        return;
      }

      router.push(`/dashboard?submitted=${body.listingId ?? ''}`);
    } catch {
      setSubmitError({ message: 'Could not reach the service. Check your connection and try again.' });
    } finally {
      setSubmitting(false);
    }
  }

  // -------------------------------------------------------------------------

  return (
    <div className="post">
      <ol className="post__steps" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`post__step ${i === step ? 'is-current' : ''} ${i < step ? 'is-done' : ''}`}
            aria-current={i === step ? 'step' : undefined}
          >
            <button type="button" onClick={() => i < step && setStep(i)} disabled={i > step}>
              <span className="post__stepnum">{i < step ? '✓' : i + 1}</span>
              <span className="post__steplabel">{label}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="post__panel">
        {step === 0 ? (
          <fieldset className="post__group">
            <legend className="post__legend">Are you renting it out or selling it?</legend>
            <p className="post__hint">
              Rent and sale are searched separately, so a renter will never see your property for
              sale.
            </p>

            <div className="post__kindrow">
              {(['RENT', 'SALE'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`post__kind ${kind === k ? 'is-selected' : ''}`}
                  aria-pressed={kind === k}
                  onClick={() => changeKind(k)}
                >
                  <strong>{k === 'RENT' ? 'Rent it out' : 'Sell it'}</strong>
                  <span>{k === 'RENT' ? 'A tenant will pay to live there' : 'Someone will buy it'}</span>
                </button>
              ))}
            </div>

            <label className="field__label" htmlFor="type">
              Property type
            </label>
            <div className="chips">
              {types.map((t) => (
                <button
                  key={t.code}
                  type="button"
                  className="chip"
                  aria-pressed={type === t.code}
                  onClick={() => setType(t.code)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {fieldErrors.type ? <p className="field__error">{fieldErrors.type}</p> : null}
          </fieldset>
        ) : null}

        {step === 1 ? (
          <fieldset className="post__group">
            <legend className="post__legend">Where is it?</legend>
            <p className="post__hint">
              Choose the state and the local government area. If yours is not on the list, type it
              instead of giving up: we will add it while your listing is reviewed.
            </p>

            <label className="field__label" htmlFor="state">
              State
            </label>
            <select
              id="state"
              className="field__input"
              value={stateCode}
              onChange={(e) => {
                setStateCode(e.target.value);
                setLgaId('');
                setAreaId('');
              }}
            >
              <option value="">Choose a state…</option>
              {options.states.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
            {fieldErrors.stateCode ? <p className="field__error">{fieldErrors.stateCode}</p> : null}

            <label className="field__label" htmlFor="lga">
              Local government area
            </label>
            <select
              id="lga"
              className="field__input"
              value={lgaId}
              disabled={!stateCode}
              onChange={(e) => {
                setLgaId(e.target.value);
                setAreaId('');
              }}
            >
              <option value="">{stateCode ? 'Choose an LGA…' : 'Choose a state first'}</option>
              {lgasForState.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            {fieldErrors.lgaId ? <p className="field__error">{fieldErrors.lgaId}</p> : null}

            {/*
                Free text for both levels, and the escape hatch that makes the rest of
                this step work at all.

                Nigeria has more LGAs than our reference data holds, and no street-by-street
                area list. A form that can only be filled from a dropdown tells a real
                landlord to give up and post on a classifieds site instead, which is the
                outcome we are trying to avoid. Both fields accept a name, which is
                recorded for an admin to curate; the listing still needs an LGA because
                everything downstream (facets, the map, area aliases) hangs off it.
              */}
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              onClick={() => {
                setNamingLga((v) => !v);
                setProposalError(null);
              }}
              aria-expanded={namingLga}
            >
              {namingLga ? 'Use the list instead' : 'My LGA is not on the list'}
            </button>

            {namingLga ? (
              <div className="field" data-naming="lga">
                <label className="field__label" htmlFor="newLgaName">
                  Type the local government area
                </label>
                <input
                  id="newLgaName"
                  className="field__input"
                  value={newLgaName}
                  maxLength={120}
                  onChange={(e) => setNewLgaName(e.target.value)}
                  placeholder="Ika South"
                />
                <p className="field__note">
                  We will add it to the area list while your listing is in review. Searches will
                  match it from then on.
                </p>
                {proposalError ? (
                  <p className="field__error" role="alert">
                    {proposalError}
                  </p>
                ) : null}
              </div>
            ) : null}

            <label className="field__label" htmlFor={useAreaText ? 'areaName' : 'area'}>
              Area or estate <span className="field__optional">optional</span>
            </label>

            {/*
                One control, not two.

                Showing a select and a text box under the same label makes it
                ambiguous which one the listing will use. The select is the default
                because it is faster and produces a filterable area; the text box
                appears when there is nothing to pick from, or when the poster asks
                for it. Whichever is showing owns the value, so a poster can never
                set both and wonder which one wins.
              */}
            {useAreaText ? (
              <>
                <input
                  id="areaName"
                  className="field__input"
                  value={newAreaName}
                  maxLength={120}
                  onChange={(e) => setNewAreaName(e.target.value)}
                  placeholder="Lekki Phase 1"
                  disabled={!lgaId && !namingLga}
                />
                <p className="field__note">
                  {lgaId || namingLga
                    ? 'Optional, but it is what people search for. We will add it while your listing is reviewed.'
                    : 'Choose an LGA first.'}
                </p>
                {areasForLga.length > 0 && !namingLga ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--tiny"
                    onClick={() => setUseAreaText(false)}
                  >
                    Pick from the list instead
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <select
                  id="area"
                  className="field__input"
                  value={areaId}
                  disabled={!lgaId}
                  onChange={(e) => {
                    setAreaId(e.target.value);
                    if (e.target.value) setNewAreaName('');
                  }}
                >
                  <option value="">
                    {lgaId
                      ? areasLoading
                        ? 'Loading areas…'
                        : 'Choose an area…'
                      : 'Choose an LGA first'}
                  </option>
                  {areasForLga.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.isActive ? '' : ' (not yet activated)'}
                    </option>
                  ))}
                </select>
                {lgaId && !areasLoading && areasForLga.length === 0 ? (
                  <p className="field__note">
                    No areas have been added under this LGA yet. Type yours below and we will attach
                    it during review.
                  </p>
                ) : null}
                <button
                  type="button"
                  className="btn btn--ghost btn--tiny"
                  onClick={() => {
                    setUseAreaText(true);
                    setAreaId('');
                  }}
                >
                  My area is not on the list
                </button>
              </>
            )}

            <p className="field__note">
              We publish the area, LGA and state. Your exact street address is only shown to
              signed-in people you reveal it to.
            </p>
          </fieldset>
        ) : null}

        {step === 2 ? (
          <fieldset className="post__group">
            <legend className="post__legend">Tell people about it</legend>

            <label className="field__label" htmlFor="title">
              Title
            </label>
            <input
              id="title"
              className="field__input"
              value={title}
              maxLength={160}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="3-bedroom semi-detached with BQ in quiet estate"
            />
            <p className="field__note">{title.length}/160</p>
            {fieldErrors.title ? <p className="field__error">{fieldErrors.title}</p> : null}

            <label className="field__label" htmlFor="description">
              Description
            </label>
            <textarea
              id="description"
              className="field__input"
              rows={7}
              value={description}
              maxLength={8000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is the property like? What is included? Who currently lives there or what will the buyer have to do?"
            />
            <p className="field__note">
              {description.trim().length} characters. Minimum 60.
            </p>
            {fieldErrors.description ? <p className="field__error">{fieldErrors.description}</p> : null}

            <div className="post__grid">
              <div>
                <label className="field__label" htmlFor="bedrooms">
                  Bedrooms
                </label>
                <input
                  id="bedrooms"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={50}
                  className="field__input"
                  value={bedrooms}
                  onChange={(e) => setBedrooms(e.target.value)}
                />
              </div>
              <div>
                <label className="field__label" htmlFor="bathrooms">
                  Bathrooms
                </label>
                <input
                  id="bathrooms"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={50}
                  className="field__input"
                  value={bathrooms}
                  onChange={(e) => setBathrooms(e.target.value)}
                />
              </div>
              <div>
                <label className="field__label" htmlFor="plotSqm">
                  Plot size (sqm)
                </label>
                <input
                  id="plotSqm"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  className="field__input"
                  value={plotSqm}
                  onChange={(e) => setPlotSqm(e.target.value)}
                />
                {fieldErrors.plotSqm ? <p className="field__error">{fieldErrors.plotSqm}</p> : null}
              </div>
              <div>
                <label className="field__label" htmlFor="builtSqm">
                  Built area (sqm)
                </label>
                <input
                  id="builtSqm"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  className="field__input"
                  value={builtSqm}
                  onChange={(e) => setBuiltSqm(e.target.value)}
                />
              </div>
            </div>

            {/*
                The title question, shown for anything being sold.

                Land needs it (a plot with no title is the classic land fraud), and so
                does a house sale, because a buyer is committing life savings against
                a piece of paper. Rent never sees this field: a landlord has no need
                to produce a deed to let a flat, and asking for one would lock out
                exactly the ordinary landlords this platform is for.
              */}
              {kind === 'SALE' ? (
                <div className="post__deed">
                  <label className="field__label" htmlFor="deedType">
                    What title document do you have?
                  </label>
                  <select
                    id="deedType"
                    className="field__input"
                    value={deedType}
                    onChange={(e) => setDeedType(e.target.value)}
                    aria-invalid={fieldErrors.deedType ? true : undefined}
                  >
                    <option value="NONE">Choose…</option>
                    <option value="COFO">Certificate of Occupancy</option>
                    <option value="DEED_OF_ASSIGNMENT">Deed of Assignment</option>
                    <option value="SURVEY">Survey</option>
                    <option value="EXCISION_GAZETTE">Excision / Gazette</option>
                    {/*
                        The honest option. A seller whose paperwork is not finished
                        picks this rather than being pushed into claiming a title they do
                        not hold, and buyers see it stated plainly on the listing.
                      */}
                    <option value="SUBJECT_TO">
                      Sale is subject to documentation (not finished yet)
                    </option>
                  </select>
                  <p className="field__note">
                    Be accurate. A wrong answer here is the single fastest way to lose a buyer. If your
                    paperwork is not complete, say so rather than guessing.
                  </p>
                  {fieldErrors.deedType ? (
                    <p className="field__error">{fieldErrors.deedType}</p>
                  ) : null}
                </div>
              ) : null}

            <span className="field__label">Features</span>
            <p className="field__note">
              These are what people filter on, so pick everything that applies. A missing feature
              here is the reason your listing never shows up in someone's search.
            </p>
            <div className="chips">
              {options.amenities.map((a) => (
                <button
                  key={a.code}
                  type="button"
                  className="chip"
                  aria-pressed={amenityCodes.includes(a.code)}
                  title={a.hint}
                  onClick={() => toggleAmenity(a.code)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}

        {step === 3 ? (
          <fieldset className="post__group">
            <legend className="post__legend">Price and location details</legend>

            {kind === 'RENT' ? (
              <div className="post__periods" role="group" aria-label="How often rent is paid">
                {(
                  [
                    ['YEARLY', 'Yearly'],
                    ['TWO_YEARLY', '2 years'],
                    ['MONTHLY', 'Monthly'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`post__period ${pricePeriod === value ? 'is-selected' : ''}`}
                    aria-pressed={pricePeriod === value}
                    onClick={() => setPricePeriod(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}

            <label className="field__label" htmlFor="price">
              Price (₦)
            </label>
            <input
              id="price"
              type="number"
              inputMode="numeric"
              min={0}
              step={1000}
              className="field__input"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            {price && Number(price) > 0 ? (
              <p className="field__note">
                That reads as {formatNaira(Number(price), { compact: false })}
                {kind === 'RENT' && pricePeriod
                  ? ` ${pricePeriod === 'MONTHLY' ? 'per month' : pricePeriod === 'TWO_YEARLY' ? 'for 2 years' : 'per year'}`
                  : ''}
                .
              </p>
            ) : null}
            {fieldErrors.price ? <p className="field__error">{fieldErrors.price}</p> : null}

            {kind === 'RENT' ? (
              <>
                <label className="field__label" htmlFor="advance">
                  How many months of advance?
                </label>
                <select
                  id="advance"
                  className="field__input"
                  value={paymentAdvance}
                  onChange={(e) => setPaymentAdvance(e.target.value)}
                >
                  <option value="">Not specified</option>
                  {[1, 2, 3, 6, 12, 18, 24].map((n) => (
                    <option key={n} value={n}>
                      {n} month{n === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            <label className="checkline">
              <input
                type="checkbox"
                checked={negotiable}
                onChange={(e) => setNegotiable(e.target.checked)}
              />
              Price is negotiable
            </label>

            <label className="field__label" htmlFor="address">
              Exact address
            </label>
            <textarea
              id="address"
              className="field__input"
              rows={2}
              value={exactAddress}
              maxLength={400}
              onChange={(e) => setExactAddress(e.target.value)}
              placeholder="Street, house number, nearest landmark"
            />
            <p className="field__note">
              Locked. Only a signed-in person you reveal it to will ever see this, never a
              signed-out visitor.
            </p>
            {fieldErrors.exactAddress ? (
              <p className="field__error">{fieldErrors.exactAddress}</p>
            ) : null}
          </fieldset>
        ) : null}

        {step === 4 ? (
          <fieldset className="post__group">
            <legend className="post__legend">Photos</legend>
            <p className="post__hint">
              At least {MIN_PHOTOS} photos. They upload straight to our storage and are compressed
              before anyone sees them.
            </p>

            <div className="post__dropzone">
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="visually-hidden"
                onChange={(e) => {
                  void onFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => fileInput.current?.click()}
                disabled={photos.length >= MAX_PHOTOS}
              >
                {photos.length === 0 ? 'Choose photos' : 'Add more photos'}
              </button>
              <p className="field__note">
                {photos.length} of {MAX_PHOTOS} · JPEG, PNG or WebP
              </p>
            </div>

            {fieldErrors.photos ? <p className="field__error">{fieldErrors.photos}</p> : null}

            <ul className="post__photos">
              {photos.map((p, i) => (
                <li key={p.preview} className={`post__photo is-${p.state}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.preview} alt="" className="post__thumb" />
                  {i === 0 ? <span className="post__cover">Cover</span> : null}
                  <div className="post__photoinfo">
                    {p.state === 'uploading' ? (
                      <progress value={p.progress} max={100} />
                    ) : null}
                    {p.state === 'processing' ? <span className="post__phstat">Processing…</span> : null}
                    {p.state === 'ready' ? <span className="post__phstat is-ok">Ready</span> : null}
                    {p.state === 'failed' ? (
                      <span className="post__phstat is-bad">{p.error ?? 'Upload failed'}</span>
                    ) : null}
                    <div className="post__phbtns">
                      {i !== 0 ? (
                        <button type="button" className="btn btn--tiny" onClick={() => makeCover(i)}>
                          Make cover
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn--tiny btn--danger"
                        onClick={() => removePhoto(i)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            {/*
                Video on the photos step, not a step of its own.

                It is optional, it is the same kind of media, and making it a
                seventh step would imply it is required. A walkthrough is the single
                strongest deterrent to someone posting a property they do not own,
                so it is offered prominently here without being mandatory.
              */}
            <VideoUpload
              videoAssetId={videoAssetId}
              onChange={setVideoAssetId}
              disabled={submitting}
            />
          </fieldset>
        ) : null}

        {step === 5 ? (
          <div className="post__group">
            <h2 className="post__legend">Check this over</h2>

            <dl className="review">
              <div className="review__row">
                <dt>Listing</dt>
                <dd>
                  {types.find((t) => t.code === type)?.label} for {kind === 'SALE' ? 'sale' : 'rent'}
                </dd>
              </div>
              <div className="review__row">
                <dt>Title</dt>
                <dd>{title}</dd>
              </div>
              <div className="review__row">
                <dt>Location</dt>
                <dd>
                  {[
                    areasForLga.find((a) => a.id === areaId)?.name,
                    // Falls back to the typed names, because on review the poster
                    // must see what they actually entered rather than "Area not
                    // set" for a location they filled in by hand.
                    newAreaName.trim() || undefined,
                    (lgasForState.find((l) => l.id === lgaId)?.name ?? newLgaName.trim()) || undefined,
                    options.states.find((s) => s.code === stateCode)?.name,
                  ]
                    .filter(Boolean)
                    .join(', ') || 'Area not set'}
                </dd>
              </div>
              <div className="review__row">
                <dt>Price</dt>
                <dd>
                  {formatNaira(Number(price || 0), { compact: false })}
                  {kind === 'RENT' && pricePeriod
                    ? ` ${pricePeriod === 'MONTHLY' ? '/month' : pricePeriod === 'TWO_YEARLY' ? '/2 years' : '/year'}`
                    : ''}
                  {negotiable ? ' · negotiable' : ''}
                </dd>
              </div>
              <div className="review__row">
                <dt>Photos</dt>
                <dd>{photos.filter((p) => p.state === 'ready').length} uploaded</dd>
              </div>
            </dl>

            <div className="post__notice">
              <strong>What happens next</strong>
              <p>
                Your listing goes to our review team and goes live within a few hours. We check
                that the photos match the description, that the price is plausible, and that no one
                has put a phone number in the description to bypass the contact lock.
              </p>
            </div>

            {submitError ? (
              <p className="contact__error" role="alert">
                {submitError.message}
              </p>
            ) : null}

            <button
              type="button"
              className="btn btn--primary btn--block"
              onClick={submit}
              disabled={submitting}
            >
              {submitting ? 'Submitting…' : 'Submit for review'}
            </button>
          </div>
        ) : null}
      </div>

      <div className="post__nav">
        <button type="button" className="btn btn--ghost" onClick={back} disabled={step === 0 || submitting}>
          Back
        </button>
        {step < STEPS.length - 1 ? (
          <button type="button" className="btn btn--primary" onClick={next}>
            Continue
          </button>
        ) : null}
      </div>
    </div>
  );
}