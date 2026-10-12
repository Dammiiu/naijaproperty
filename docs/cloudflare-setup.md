# Cloudflare R2 + Stream setup

Both are needed before real uploads work. Everything below is free at launch scale.

---

## 1. R2 (photo storage)

### Enable R2 and set a billing method

1. Sign in at <https://dash.cloudflare.com>
2. Left rail → **R2** → **Get started**
3. R2 requires a payment method even at the free tier (it will not charge without
   usage). Add a card.

### Create the bucket

1. R2 → **Create bucket**
2. Bucket name: `naijaproperty-media`
3. Location: **Automatic** (recommended)
4. Storage class: **Standard**

### Create the API token

1. R2 → **Manage R2 API Tokens** (top right) → **Create API Token**

   Use an **R2 API Token**, not a legacy **User API Key**. A user API key is tied
   to your Cloudflare account rather than to a job, cannot be scoped to one
   bucket, and keeps working after you are removed from the account. An R2 API
   token can be scoped and revoked independently.

2. **Permissions** — this is the complete list:

   | Permission | Access |
   |---|---|
   | Account → R2 Storage → **Objects** | **Read & Write** |

   That is one permission. Nothing else is needed, and adding anything else
   widens the blast radius for no benefit.

   **Read** is not optional. The media worker downloads each upload in order to
   apply EXIF stripping and WebP compression before storing it, so the API needs
   to read the bytes back. Write covers the presigned browser upload, the
   compressed rewrite, and the orphan reaper's deletes.

   Not required, and deliberately not requested:

   | Permission | Why not |
   |---|---|
   | R2 Storage → Buckets | We never list buckets. The bucket name is a fixed env var. |
   | Account Settings → Read | No account metadata is read. |
   | Workers Scripts → Edit | Only needed for the Cloudflare *Images* API. We do not call it. |

3. **Scope** — where the form offers **Specify bucket(s)**, choose
   `naijaproperty-media` rather than *all buckets*. This is the finest granularity
   the Cloudflare UI offers for an R2 token; S3-style prefix scoping is not
   available here.

4. **TTL**: leave as "Not set" — the token is long-lived. Rotate it deliberately,
   not on a timer.

5. Click **Create API Token**. Copy the three values now; the secret is shown
   once.

### Values to put in `.env`

```
R2_ACCOUNT_ID=<Account ID from the R2 overview page>
R2_ACCESS_KEY_ID=<from the token dialog>
R2_SECRET_ACCESS_KEY=<from the token dialog>
R2_BUCKET=naijaproperty-media
R2_ENDPOINT=https://<Account ID>.r2.cloudflarestorage.com
R2_PUBLIC_URL=https://pub-<hash>.r2.dev
```

`R2_PUBLIC_URL` is shown on the bucket's Settings page after you run
"Connect Domain" (or use the `*.r2.dev` dev URL it displays).

### Enable the public dev URL

Bucket → Settings → **Public Access** → **Connect Domain** → enable the
`r2.dev` subdomain. Fine for development. For production, put a real domain in
front (e.g. `media.naijaproperty.ng`) so you control caching headers.

### Required: CORS

**Without a matching origin, photo upload does not work at all from a browser.**
This is a bucket setting, not a code fix.

Check the current state first:

```powershell
npm run r2:cors:check -w @naijaproperty/api
```

It prints one line per origin the app is served from.

**This has already bitten once.** The rule was written when the dev server ran
on port 3100, and the app later moved to port 3000. R2 matches origins exactly,
so the rule kept working on 3100 while the app silently stopped being able to
upload on 3000 — and the failure looks identical to having no rule at all.
Always include the port the app is actually on.

If any origin fails, get the full rule:

```powershell
npm run r2:cors -w @naijaproperty/api
```

and paste the output into **R2 bucket → Settings → CORS**. It cannot apply the
rule itself, because the `R2_ACCESS_KEY_ID` in `.env` is scoped to objects and
is refused on `PutBucketCors`; that needs a token with **Account → Workers R2
Storage → Edit**. Applying it in the dashboard is the intended path.

The rule:

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:3000",
      "http://localhost:3100",
      "https://naijaproperty.ng",
      "https://www.naijaproperty.ng"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`AllowedHeaders: ["*"]` is required because the browser sends `content-type` on
the presigned PUT, and a preflight that does not allow it is rejected before the
upload starts. `HEAD` matters too: the gallery reads image dimensions before
rendering.

Save, then hard-reload the app. Browsers cache a failed preflight, so a normal
reload can leave a stale 403 in place.

#### How to tell this is what is broken

The symptom in the browser is deliberately unhelpful: a blocked preflight reaches
JavaScript as a generic `Network error`, with no status code, because the browser
will not tell a page why it was blocked. The console shows the real reason:

```
... from origin 'http://localhost:3100' has been blocked by CORS policy:
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

To confirm the rule is live without touching the UI, run
`npm run r2:cors:check -w @naijaproperty/api`.

Two traps when doing this by hand, both of which produce a wrong answer:

- **Probe the virtual-hosted URL.** The browser PUTs to
  `https://<bucket>.<account>.r2.cloudflarestorage.com/<key>`, which is what
  `getSignedUrl` produces. Probing the path-style form
  (`https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`) tests a
  different request that the bucket's CORS rule does not cover, so it 403s even
  when the rule is correct. That mistake briefly made a working rule look
  entirely absent.
- **A server-side upload succeeding proves nothing.** The same-origin policy does
  not apply to non-browser clients, so a script can PUT to the presigned URL
  successfully while every browser fails. Always check the preflight response for
  `Access-Control-Allow-Origin`.

Note that when the browser does fail this way, **the bytes still reach the
bucket**: the object is written and only the response is discarded. So the poster
sees "Upload blocked by the browser" on every photo while R2 quietly accumulates
orphans. That is how 266 unattachable images ended up in the media table before
this was diagnosed.

---

## 2. Stream (walkthrough video)

### Create the token

The token needs the **Stream** scope. Without it every Stream endpoint returns
403, and the symptom is a 502 from our own API with "Video upload is unavailable"
in the log, which reads like an outage rather than a misconfigured token.

1. **My Profile** → **API Tokens** → **Create Token** → **Edit template** (or Custom).
2. **Permissions** → Add:
   - **Account** → **Stream** → **Edit**
3. **Resources** → **Include** → your specific account.
4. **Client IP Filtering**: leave blank for local development; pin it in
   production so the token is useless if it leaks.
5. Copy into `.env`:

```
CLOUDFLARE_ACCOUNT_ID=<same Account ID as R2>
CLOUDFLARE_STREAM_TOKEN=<the Stream token>
```

**Stream read is not separate from Stream write.** Cloudflare models Stream as a
single Edit permission. If every `/stream` call 403s including read, the scope is
missing entirely rather than being read-only.

No extra permission is needed to build playback URLs. The customer subdomain
(`customer-f33zs165nr7gyfy4.cloudflarestream.com`) is **not** exposed on the
Cloudflare account object, so it cannot be looked up; it arrives in the webhook
payload itself as `playback.hls`, and we store that verbatim.

### Set up the webhook

Video bytes go browser to Cloudflare, so **the webhook is the only signal that
encoding finished**. Without it a video can never be marked ready and no listing
can reference one.

1. Create the subscription (Cloudflare allows **one per account**):

```powershell
curl -X PUT --header "Authorization: Bearer <CLOUDFLARE_STREAM_TOKEN>" `
  https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/stream/webhook `
  --data "{\"notificationUrl\":\"https://<api-host>/api/v1/media/stream/webhook\"}"
```

2. Copy the `secret` from the response into `.env`:

```
CLOUDFLARE_STREAM_WEBHOOK_SECRET=<the webhook signing secret>
```

This secret is separate from the API token on purpose: the API token is sent
outbound on every upload, this one only ever verifies inbound callbacks. Rotating
one does not invalidate the other.

#### Cloudflare cannot reach localhost

Stream refuses to deliver to local or private addresses. During development the
webhook will simply never fire, which looks identical to a broken handler. Expose
the API first:

```powershell
cloudflared tunnel --url http://localhost:4000
```

#### Payload and signature shape

Both are easy to get wrong in ways that fail **silently**, returning 200 while
doing nothing. The details, because each one has already been got wrong here:

- The video object is at the **top level** of the body, not nested under `video`.
- `status` is an **object** (`{ state, pctComplete, errorReasonCode }`), not a
  string. `readyToStream` must also be `true` for the video to actually play.
- The `Webhook-Signature` header is `time=<unix>,sig1=<hex>`, and the HMAC covers
  **`<time>.<raw body>`**, not the body alone.
- Error reasons appear under **both** `errorReasonText` and `errReasonText`
  depending on the shape, so both are read.
- `playback.hls` carries the manifest URL. It is stored verbatim rather than
  reconstructed, because the customer subdomain cannot be looked up.

`npm run verify:stream-webhook -w @naijaproperty/api` runs 18 checks against
Cloudflare's own documented example payloads, covering all of the above plus
replay rejection, deduplication and uid isolation.

### Verify the whole path

```powershell
npm run verify:stream -w @naijaproperty/api
```

This checks the token's shape, account read, Stream read, Stream write (by making
the exact `direct_upload` call the app makes), the returned upload URL, and the
webhook signing. It writes nothing and uploads no video, so it is safe to run
repeatedly and against a production account. It prints the specific dashboard
navigation to fix when a check fails.

### Enable on-demand encoding (optional, costs money)

Stream → **On-demand encoding** → enable if you want to control when
transcoding happens. Leave it off at first: standard encoding is included and is
cheaper for low volume.

### Where video is served from

Stream returns a per-UID HLS manifest on `customer-<code>.cloudflarestream.com`.
We store the uid, the manifest URL, the poster frame and the duration on the media
asset row when the webhook confirms the video is ready. **Video bytes never touch
our API or R2.**

---

## 3. Verify once `.env` is filled

```powershell
# R2 reachable?
$env:AWS_ACCESS_KEY_ID="<R2_ACCESS_KEY_ID>"
Invoke-RestMethod -Uri "https://<ACCOUNT_ID>.r2.cloudflarestorage.com/naijaproperty-media" -Method Get

# Or simply start the API and watch for this in the log:
#   Naijaproperty API listening on http://localhost:4000
#   Cloudflare Stream: configured
```

Then drive a real upload:

1. Sign in at http://localhost:3100
2. Post a property with at least 5 photos and one video
3. The photos upload straight from your browser to R2 — the network tab will show
   a `PUT` to `*.r2.cloudflarestorage.com`, **not** to `localhost:4000`. That is
   the architectural claim working.

---

## Verified behaviour and two traps

The image pipeline has been run end to end against this bucket: presign → browser
PUT → HEAD → complete → compress → public fetch. All of it passes, and a 40KB
3000×2250 JPEG is stored as a 5.4KB 2000×1500 WebP (86% smaller).

Two things about R2 presigned PUTs are not obvious and both break uploads
completely, so they are recorded here rather than left in a code comment:

### 1. User metadata breaks the signature

Setting `Metadata` on the presigned `PutObject` makes the SDK fold an
`x-amz-meta-*` header into the SigV4 canonical request. R2 does not canonicalise
those headers the same way, so it computes a different signature and rejects the
PUT with `SignatureDoesNotMatch`.

Verified directly against the bucket:

| Presigned PUT | Result |
|---|---|
| `ContentType` only | **200** |
| `Metadata` only | 403 `SignatureDoesNotMatch` |
| `ContentType` + `Metadata` | 403 `SignatureDoesNotMatch` |

Traceability does not need the metadata — the object key already embeds the owner
and asset id — so it is simply not set.

### 2. `ContentLength` cannot be signed

`Content-Length` is a **forbidden header name** in the Fetch spec. No browser can
set it, so pinning it into the signature makes the URL unusable from a real
browser even though it works fine from a server-side test.

The size limit is therefore enforced at `complete` time by comparing the
`HeadObject` response against the declared byte count. That is the stronger check
anyway: it measures what was actually stored rather than what the client claimed.

### Object key layout

```
image/<shard>/<assetId>.webp
```

`shard` is the first two hex characters of `sha256(assetId)`. Two constraints force
this shape:

- **The key is the public URL.** R2 has no rewrite layer, so a `r2.dev` URL can
  only address an object at its real key. The key therefore cannot contain the
  owner's user id — that would publish it.
- **Keys must spread across partitions.** Sharding on the first characters of the
  id does not work for cuids, because every recent one starts `cm`.

Images always carry a `.webp` extension because the worker converts every one of
them regardless of the upload format. Serving only ever happens on a `READY`
asset, so the extension always matches the stored bytes.

---

## Cost control notes

- **R2 has no egress fee.** This is the main reason it was chosen over S3: serving
  photos to Nigerian users is the dominant cost, and on S3 it would be the
  largest line item.
- **Photos are compressed once, on the way in.** The worker rewrites every upload
  to a bounded WebP (max 2000px, quality 82) before the bytes are stored, so a
  3MB phone photo lands at roughly 120KB. One file is stored, not three
  derivatives.
- **Video is not stored by us at all.** Stream transcodes and serves from its own
  CDN; we only keep the UID.
- Set a **Cloudflare billing alert** at the R2 dashboard so an accidental run of
  orphaned uploads is noticed rather than billed.

### Known limitation: display-size resizing

The compression policy stores one bounded WebP and serves it at every size. That
is fine while the stored file is ~120KB, but a phone on 2G would still download
the full-size image to fill a 400px card.

Cloudflare Image Transformations would fix this, but they are applied through a
**zone**, not through the `r2.dev` subdomain — so they need a real hostname in
front (`media.naijaproperty.ng`). That is deliberately not done yet: it requires
DNS, a TLS certificate and a caching policy, none of which are worth the
complexity before there is real traffic to optimise for.

Until then the images are correct and affordable, just not optimally sized per
device. Revisit when the listing volume justifies it.
