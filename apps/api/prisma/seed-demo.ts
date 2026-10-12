/**
 * Demo dataset.
 *
 * Dev-only. Creates a realistic set of LIVE listings so the browse, detail and
 * admin surfaces are all navigable before any real posting happens. Nothing here
 * is referenced by production code paths.
 *
 * Media is generated locally as WebP files under apps/web/public/demo/ rather
 * than uploaded to R2, so the dataset is reproducible with no storage
 * credentials. Each asset carries a `demo/...` storage key, which is what
 * `publicImageUrl` keys off when R2 is unconfigured.
 *
 * Run: npm run db:demo -w @naijaproperty/api
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { AMENITIES } from '@naijaproperty/contracts';
import {
  PrismaClient,
  PricePeriod,
  DeedType,
  ListingKind,
  VerificationTier,
} from '@prisma/client';
import { hash } from 'argon2';
import sharp from 'sharp';

loadEnv({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'),
});

const prisma = new PrismaClient();

/**
 * Stores a generated demo image and returns its storage key.
 *
 * Writes to R2 when R2 is configured, so the browse surface is served by the same
 * code path production will use. That matters: a demo dataset that writes files
 * into the web app's public directory exercises a dev-only branch, and the real
 * upload path — presign, key layout, public URL — stays untested.
 *
 * Falls back to the local public directory when R2 is absent, so the dataset is
 * still usable on a fresh clone with no storage credentials.
 */
async function storeDemoImage(
  assetId: string,
  bytes: Buffer,
  category: 'image' | 'video' = 'image',
): Promise<string> {
  if (isR2Configured) {
    // Same key layout as MediaService.buildKey, so publicImageUrl resolves the
    // object with no special-casing.
    const shard = createHash('sha256').update(assetId).digest('hex').slice(0, 2);
    const key = `${category}/${shard}/${assetId}.webp`;
    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET!,
        Key: key,
        Body: bytes,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return key;
  }

  await mkdir(DEMO_DIR, { recursive: true });
  await writeFile(join(DEMO_DIR, `${assetId}.webp`), bytes);
  return `demo/${assetId}.webp`;
}

/**
 * A poster URL for a demo video.
 *
 * Only meaningful when R2 holds the poster; with no storage configured the poster
 * is written locally and served from the web app instead, so the R2 branch
 * returns null rather than inventing a URL that 404s.
 */
function demoVideoPoster(assetId: string): string | null {
  return isR2Configured ? null : `/demo/${assetId}-video.webp`;
}

// apps/api/prisma/seed-demo.ts -> repo root is three levels up
// (prisma -> api -> apps -> <root>). Same depth as the dotenv lookup above.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEMO_DIR = join(REPO_ROOT, 'apps', 'web', 'public', 'demo');

const isR2Configured = Boolean(
  process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
);

const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },
});

/** Demo media owner, so re-running is idempotent via the email unique key. */
const DEMO_PASSWORD = 'DemoPass!2026njp';

interface AreaSpec {
  name: string;
  aliases: string[];
  lga: string;
  state: string;
  lat: number;
  lng: number;
}

/**
 * Real areas in the states with the highest listing volume. Coordinates are
 * approximate area centroids, which is all the jittered map pin needs.
 */
// Area-to-LGA mapping is checked against the seeded LGA table at run time and
// any mismatch is reported as a skip rather than silently creating an orphan.
// Note that Yaba and Maryland are not LGAs — they sit inside Lagos Mainland.
// Abuja's six LGAs (Abaji, Bwari, Gwagwalada, Kuje, Kwali, Riyi) absorbed the
// former Municipal Area Council, so Wuse, Maitama, Asokoro and Jabi are all
// Gwagwalada.
const AREAS: AreaSpec[] = [
  { name: 'Lekki Phase 1', aliases: ['Lekki', 'Lekki Phase One'], lga: 'Eti-Osa', state: 'LA', lat: 6.4474, lng: 3.4735 },
  { name: 'Lekki Phase 2', aliases: ['Lekki 2', 'Lekki Phase Two'], lga: 'Eti-Osa', state: 'LA', lat: 6.455, lng: 3.485 },
  { name: 'Victoria Island', aliases: ['VI', 'V.I.'], lga: 'Eti-Osa', state: 'LA', lat: 6.4281, lng: 3.4219 },
  { name: 'Ikoyi', aliases: ['Ikoyi GRA'], lga: 'Eti-Osa', state: 'LA', lat: 6.455, lng: 3.435 },
  { name: 'Ikeja GRA', aliases: ['GRA Ikeja', 'Ikeja'], lga: 'Ikeja', state: 'LA', lat: 6.6018, lng: 3.3515 },
  { name: 'Yaba', aliases: ['Yaba, Lagos'], lga: 'Lagos Mainland', state: 'LA', lat: 6.5095, lng: 3.3711 },
  { name: 'Maryland', aliases: ['Maryland, Lagos'], lga: 'Lagos Mainland', state: 'LA', lat: 6.5203, lng: 3.3796 },
  { name: 'Surulere', aliases: ['Surulere, Lagos'], lga: 'Surulere', state: 'LA', lat: 6.5, lng: 3.3567 },
  { name: 'Egbeda', aliases: ['Egbeda', 'Egbeda Lagos'], lga: 'Egbeda', state: 'LA', lat: 6.45, lng: 3.3167 },
  { name: 'Alaba', aliases: ['Alaba, Lagos', 'Kurigbo'], lga: 'Surulere', state: 'LA', lat: 6.4972, lng: 3.3369 },
  { name: 'Gwarinpa', aliases: ['Gwarinpa Estate'], lga: 'Kwali', state: 'FC', lat: 9.1117, lng: 7.4011 },
  { name: 'Asokoro Extension', aliases: ['Asokoro'], lga: 'Gwagwalada', state: 'FC', lat: 9.0417, lng: 7.4833 },
  { name: 'Wuse 2', aliases: ['Wuse', 'Wuse II'], lga: 'Gwagwalada', state: 'FC', lat: 9.0765, lng: 7.3986 },
  { name: 'Jabi', aliases: ['Jabi, Abuja'], lga: 'Gwagwalada', state: 'FC', lat: 9.0633, lng: 7.4267 },
  { name: 'Maitama', aliases: ['Maitama District'], lga: 'Gwagwalada', state: 'FC', lat: 9.085, lng: 7.4939 },
  { name: 'Lugbe', aliases: ['Lugbe, Abuja'], lga: 'Kuje', state: 'FC', lat: 8.9833, lng: 7.3667 },
  { name: 'Kuje', aliases: ['Kuje, Abuja'], lga: 'Kuje', state: 'FC', lat: 9.1472, lng: 7.2264 },
];

interface PosterSpec {
  email: string;
  displayName: string;
  phone: string;
  phoneVerified: boolean;
  tier: VerificationTier;
  agency?: { name: string; licenceVerified: boolean };
}

/**
 * Poster mix is deliberate: roughly half phone-verified so the VERIFIED_OWNER
 * badge appears on some cards and not others, which is the only honest way to
 * demo the badge cap.
 */
const POSTERS: PosterSpec[] = [
  { email: 'demo.ada@listers.ng', displayName: 'Ada Obi', phone: '+2348010001001', phoneVerified: true, tier: VerificationTier.PHONE },
  { email: 'demo.tunde@listers.ng', displayName: 'Tunde Bakare', phone: '+2348010001002', phoneVerified: true, tier: VerificationTier.VERIFIED_AGENT, agency: { name: 'Bakare & Sons Properties', licenceVerified: true } },
  { email: 'demo.chidi@listers.ng', displayName: 'Chidi Nwosu', phone: '+2348010001003', phoneVerified: false, tier: VerificationTier.NONE },
  { email: 'demo.zainab@listers.ng', displayName: 'Zainab Yusuf', phone: '+2348010001004', phoneVerified: true, tier: VerificationTier.PHONE, agency: { name: 'Zee Realty Hub', licenceVerified: false } },
  { email: 'demo.eze@listers.ng', displayName: 'Eze Okonkwo', phone: '+2348010001005', phoneVerified: false, tier: VerificationTier.NONE },
  { email: 'demo.femi@listers.ng', displayName: 'Femi Adesanya', phone: '+2348010001006', phoneVerified: true, tier: VerificationTier.PHONE },
  { email: 'demo.grace@listers.ng', displayName: 'Grace Uche', phone: '+2348010001007', phoneVerified: true, tier: VerificationTier.VERIFIED_AGENT, agency: { name: 'Uche Realtors', licenceVerified: true } },
  { email: 'demo.sani@listers.ng', displayName: 'Sani Bello', phone: '+2348010001008', phoneVerified: false, tier: VerificationTier.NONE },
];

/**
 * Accounts that have actually rented or bought, and so are allowed to review.
 *
 * Separate from POSTERS on purpose. The poster accounts own the demo listings,
 * and the API forbids reviewing your own listing, so they can only ever leave
 * cross-reviews on each other's properties. Real reviewers are people who
 * interacted with a listing they did not own, which is the only situation the
 * review feature is meant to represent.
 *
 * Verification tiers are varied on purpose: a reviewer who never verified a
 * phone number should render as unverified, so the badge in the review list is
 * honest rather than uniformly green.
 */
const REVIEWERS: Array<{
  email: string;
  displayName: string;
  phone: string;
  phoneVerified: boolean;
  tier: VerificationTier;
}> = [
  { email: 'renter.ngozi@listers.ng', displayName: 'Ngozi Ibeh', phone: '+2348020002001', phoneVerified: true, tier: VerificationTier.PHONE },
  { email: 'renter.emeka@listers.ng', displayName: 'Emeka Nwosu', phone: '+2348020002002', phoneVerified: true, tier: VerificationTier.PHONE },
  { email: 'renter.aisha@listers.ng', displayName: 'Aisha Bello', phone: '+2348020002003', phoneVerified: false, tier: VerificationTier.NONE },
  { email: 'buyer.kemi@listers.ng', displayName: 'Kemi Adeyemi', phone: '+2348020002004', phoneVerified: true, tier: VerificationTier.PHONE },
  { email: 'renter.ume@listers.ng', displayName: 'Uche Nnamdi', phone: '+2348020002005', phoneVerified: true, tier: VerificationTier.PHONE },
  { email: 'buyer.dauda@listers.ng', displayName: 'Dauda Sanni', phone: '+2348020002006', phoneVerified: false, tier: VerificationTier.NONE },
  { email: 'renter.ife@listers.ng', displayName: 'Ifeoma Obi', phone: '+2348020002007', phoneVerified: true, tier: VerificationTier.PHONE },
  { email: 'buyer.tunde2@listers.ng', displayName: 'Tunde Afolabi', phone: '+2348020002008', phoneVerified: true, tier: VerificationTier.PHONE },
];

interface ReviewSpec {
  /**
   * Substring of the listing title. Resolved at seed time.
   *
   * A title rather than an index, because the LISTINGS array gets reordered and
   * edited constantly. An index would silently attach a review to a different
   * property the next time someone inserts a listing, which is precisely the
   * "review ended up on the wrong listing" failure being fixed here.
   */
  listing: string;
  /** Index into REVIEWERS. */
  reviewer: number;
  overall: 1 | 2 | 3 | 4 | 5;
  communication: 1 | 2 | 3 | 4 | 5;
  accuracy: 1 | 2 | 3 | 4 | 5;
  value: 1 | 2 | 3 | 4 | 5;
  body: string;
  /**
   * How the reviewer qualified. Both routes are represented because the review
   * API enforces the same rule, so the demo data must not contradict it.
   */
  via: 'REVEALED' | 'STAY_RECORDED';
  /** Days ago. Drives ordering so the summary is not all written at once. */
  daysAgo: number;
}

/**
 * Reviews attached to specific listings.
 *
 * These exist to make reputation real rather than decorative. A marketplace
 * where every listing reads "0 reviews" gives a buyer no way to tell a landlord
 * who has been reliable for four years from one who has just posted, and gives a
 * bad landlord nothing to lose. Both of those are why rivals are trusted and this
 * is not.
 *
 * The mix matters as much as the volume, so this is deliberately not all
 * positive:
 *
 *  - The Egbeda 3-room flat has three reviews averaging 1.7, because a
 *    poster who takes money up front and stops answering is the exact scenario
 *    the feature exists to expose.
 *  - Several listings carry a single 4 or 5, which is what a genuinely good but
 *    lightly used property looks like.
 *  - A few listings carry none at all, which is real and must stay real: a new
 *    listing has no track record, and the UI has to say "not yet reviewed"
 *    rather than imply a score.
 *
 * Sub-ratings are not clones of `overall`. A landlord can be honest and
 * communicative while the advertised price was optimistic, which is the most
 * useful distinction the form offers.
 */
const REVIEWS: ReviewSpec[] = [
  {
    listing: '3-room bungalow with a big yard, Egbeda', reviewer: 0,
    overall: 5, communication: 5, accuracy: 4, value: 4,
    body:
      'I lived here for two years. The owner answered every message the same day and came to fix the borehole within a day of reporting it. What you see in the photos is what the yard actually looks like, which is rarer than it should be. Rent was fair for the size.',
    via: 'STAY_RECORDED', daysAgo: 420,
  },
  {
    listing: '3-room bungalow with a big yard, Egbeda', reviewer: 4,
    overall: 4, communication: 4, accuracy: 5, value: 4,
    body:
      'Quiet compound, neighbours are civil, and the water runs most of the time. The listing said 2 baths and it is genuinely 2. Only note is that the road gets hard to enter in the rain.',
    via: 'REVEALED', daysAgo: 300,
  },
  {
    listing: '3-room bungalow with a big yard, Egbeda', reviewer: 6,
    overall: 5, communication: 5, accuracy: 4, value: 5,
    body:
      'Good value for Egbeda. The yard is big enough for a small business and the owner was flexible on the payment schedule when I asked honestly about it rather than pretending I had the full rent.',
    via: 'STAY_RECORDED', daysAgo: 150,
  },
  {
    listing: 'Spacious 2-room flat sharing, Maryland', reviewer: 2,
    overall: 4, communication: 4, accuracy: 4, value: 5,
    body:
      'Sharing flat but the housemates are all working adults and the house rules are actually followed. Landlord was fair when we asked about the increase.',
    via: 'STAY_RECORDED', daysAgo: 260,
  },
  {
    listing: 'Renovated 3-bedroom flat with BQ in Ikeja GRA', reviewer: 1,
    overall: 5, communication: 5, accuracy: 5, value: 3,
    body:
      'Genuinely beautiful and everything advertised was there, including the BQ. It is expensive for what you get, that is my only complaint. You are paying for the renovation and the location, not for value.',
    via: 'REVEALED', daysAgo: 95,
  },
  {
    listing: 'Renovated 3-bedroom flat with BQ in Ikeja GRA', reviewer: 7,
    overall: 4, communication: 5, accuracy: 5, value: 3,
    body:
      'The agent was honest about what needed replacing, which I appreciated. Tiled floors in the kitchen were already showing wear when we moved in, six months before the end of the lease.',
    via: 'REVEALED', daysAgo: 60,
  },
  {
    listing: 'Executive 3-bedroom flat, Ikoyi GRA', reviewer: 5,
    overall: 4, communication: 4, accuracy: 4, value: 4,
    body:
      'The building is well maintained and the generator is almost always on. Parking is the real problem: by 7pm there is nowhere to stop on the street for visitors.',
    via: 'STAY_RECORDED', daysAgo: 200,
  },
  {
    listing: 'Modern self-contain in Surulere, own compound', reviewer: 3,
    overall: 5, communication: 5, accuracy: 5, value: 5,
    body:
      'Best value I have had in Surulere. Own compound, so no landlord knocking at odd hours, and the water storage is big enough that we have not had to buy a single tanker in a year.',
    via: 'STAY_RECORDED', daysAgo: 330,
  },
  {
    listing: 'Serviced studio mini flat, Asokoro Extension', reviewer: 6,
    overall: 4, communication: 4, accuracy: 4, value: 4,
    body:
      'Fine for a working single person. Cleaning is weekly and the WiFi is reliable, which is what you are actually paying for. The room is small and the kitchen is a corner.',
    via: 'REVEALED', daysAgo: 120,
  },
  {
    listing: 'Newly renovated 2-bedroom flat, Lekki Phase 2', reviewer: 0,
    overall: 3, communication: 3, accuracy: 3, value: 4,
    body:
      'Presentable and the rent is fair for Lekki Phase 2. Two things you should know before signing: the water runs about two hours a day from the shared tank, and the compound is still finishing the block behind us, so there is building noise until about 6pm.',
    via: 'REVEALED', daysAgo: 45,
  },
  {
    listing: '5-bedroom detached house with pool, Lekki Phase 1', reviewer: 3,
    overall: 5, communication: 5, accuracy: 5, value: 4,
    body:
      'Viewed four houses in Lekki before this one and this was the only one where the documents matched what we were told. Pool really is pool, not a bowl of green water. Expensive but you are buying the paperwork as much as the house.',
    via: 'REVEALED', daysAgo: 70,
  },
  {
    listing: 'Furnished 3-bedroom short-let on Victoria Island', reviewer: 1,
    overall: 5, communication: 5, accuracy: 5, value: 5,
    body:
      'Monthly rate is excellent for what you get. Everything was already installed and working, power was stable throughout, and check-in took two minutes. Stayed four months, would stay again.',
    via: 'STAY_RECORDED', daysAgo: 180,
  },
  {
    listing: 'Furnished 3-bedroom short-let on Victoria Island', reviewer: 7,
    overall: 4, communication: 4, accuracy: 5, value: 5,
    body:
      'Very smooth arrangement and the host sorted an early check-in when my flight moved. Internet held up for work calls all month.',
    via: 'STAY_RECORDED', daysAgo: 110,
  },
  {
    listing: '3-bedroom bungalow to let, Lekki Phase 1', reviewer: 5,
    overall: 5, communication: 4, accuracy: 5, value: 5,
    body:
      'Straightforward letting. Paid rent on time for the full year, got my deposit back without arguing, and the agent fixed a broken window within two days.',
    via: 'STAY_RECORDED', daysAgo: 380,
  },
  {
    listing: '5-bedroom duplex with maid quarters, Lekki Phase 2', reviewer: 2,
    overall: 4, communication: 4, accuracy: 4, value: 4,
    body:
      'The courtyard makes it. Rooms are a decent size for a duplex and the street is quiet at night. Landlord is not chatty but does answer, and gets things fixed.',
    via: 'STAY_RECORDED', daysAgo: 240,
  },

  /*
   * The negative block.
   *
   * These are the reason the feature exists. Without a listing that visibly
   * carries a bad reputation, every landlord looks equally trustworthy and the
   * review count is just decoration.
   */
  {
    listing: '3-room flat in Egbeda, quiet close to the market', reviewer: 0,
    overall: 2, communication: 2, accuracy: 3, value: 3,
    body:
      'Took a one-year lease and paid two years upfront as was agreed. The owner became very hard to reach after month three and the window in the room had been broken for most of it. I had to chase for a refund of the overpayment for two months before getting any response.',
    via: 'REVEALED', daysAgo: 210,
  },
  {
    listing: '3-room flat in Egbeda, quiet close to the market', reviewer: 6,
    overall: 2, communication: 1, accuracy: 2, value: 3,
    body:
      'The flat itself is fine and the price is not unreasonable for Egbeda. What is not fine is that the agent promised water storage that was not there, and stopped replying when I raised it. I would rent again from an area like this, just not from this person.',
    via: 'REVEALED', daysAgo: 140,
  },
  {
    listing: '3-room flat in Egbeda, quiet close to the market', reviewer: 4,
    overall: 1, communication: 1, accuracy: 2, value: 2,
    body:
      'Do not take this one without a written inventory and a receipt for every naira. I moved in to a room that did not match the photos, and recovering my deposit turned into the worst experience I have had renting in Lagos.',
    via: 'STAY_RECORDED', daysAgo: 65,
  },
  {
    listing: '4-bedroom semi-detached duplex in Ikoyi GRA', reviewer: 3,
    overall: 2, communication: 3, accuracy: 2, value: 3,
    body:
      'The house itself is a fair property, but the plot size quoted to me was overstated by a good margin and the agent was vague about the survey. Nothing dishonest on paper that I could prove, but I would have made a different decision with accurate numbers.',
    via: 'REVEALED', daysAgo: 155,
  },
];

interface ListingSpec {
  poster: number;
  area: string;
  kind: ListingKind;
  type: string;
  title: string;
  description: string;
  price: number;
  pricePeriod: PricePeriod;
  bedrooms?: number;
  bathrooms?: number;
  plotSqm?: number;
  builtSqm?: number;
  amenities: string[];
  deedType?: DeedType;
  titleVerified?: boolean;
  hasVideo?: boolean;
  negotiable?: boolean;
  /** Days ago it went live. Drives the NEW badge window. */
  publishedDaysAgo: number;
  views: number;
  /** How many generated images to write. */
  photos: number;
}

const LISTINGS: ListingSpec[] = [
  {
    poster: 0, area: 'Lekki Phase 1', kind: ListingKind.SALE, type: 'DETACHED_HOUSE',
    title: '5-bedroom detached house with pool, Lekki Phase 1',
    description:
      'A generously proportioned detached house on a quiet cul-de-sac. All rooms are en-suite, the kitchen is fitted with imported units, and there is a 3-bedroom BQ attached. The pool was retiled two years ago. Documents are clean and we hand over on completion of the purchase.',
    price: 385_000_000, pricePeriod: PricePeriod.NONE,
    bedrooms: 5, bathrooms: 6, plotSqm: 1000, builtSqm: 450,
    amenities: ['SWIMMING_POOL', 'SECURITY_GATED', 'SECURITY_24H', 'SECURITY_GATED', 'BOYS_QUARTERS', 'GARDEN', 'PARKING'],
    deedType: DeedType.DEED_OF_ASSIGNMENT, titleVerified: true, hasVideo: true,
    publishedDaysAgo: 3, views: 2140, photos: 6,
  },
  {
    poster: 1, area: 'Victoria Island', kind: ListingKind.RENT, type: 'SHORT_LET',
    title: 'Furnished 3-bedroom short-let on Victoria Island',
    description:
      'Serviced short-let available on a monthly or quarterly basis. Includes power, water, cleaning twice weekly and wifi. The building has a lift, standby and a dedicated parking bay. Ideal for relocating staff or a stay of a few months.',
    price: 4_500_000, pricePeriod: PricePeriod.MONTHLY,
    bedrooms: 3, bathrooms: 3, builtSqm: 180,
    amenities: ['FURNISHED', 'SECURITY_24H', 'LIFT', 'SECURITY_GATED', 'SWIMMING_POOL', 'GYM', 'PARKING'],
    publishedDaysAgo: 1, views: 890, photos: 5,
  },
  {
    poster: 3, area: 'Ikoyi', kind: ListingKind.SALE, type: 'SEMI_DETACHED_HOUSE',
    title: '4-bedroom semi-detached duplex in Ikoyi GRA',
    description:
      'A well maintained semi-detached duplex on a quiet street in the GRA. Marble floors downstairs, tiled throughout, and a rooftop that has been waterproofed. The estate is gated with a resident guard.',
    price: 295_000_000, pricePeriod: PricePeriod.NONE,
    bedrooms: 4, bathrooms: 5, plotSqm: 500, builtSqm: 320,
    amenities: ['SECURITY_GATED', 'SECURITY_24H', 'SECURITY_GATED', 'BOYS_QUARTERS', 'PARKING'],
    deedType: DeedType.COFO, titleVerified: true,
    publishedDaysAgo: 12, views: 3410, photos: 4,
  },
  {
    poster: 6, area: 'Lekki Phase 2', kind: ListingKind.RENT, type: 'FLAT_APARTMENT',
    title: 'Newly renovated 2-bedroom flat, Lekki Phase 2',
    description:
      'Freshly renovated two-bedroom flat, first floor, with a large balcony overlooking the compound. The estate is managed and the service charge is already included in the rent.',
    price: 2_200_000, pricePeriod: PricePeriod.MONTHLY,
    bedrooms: 2, bathrooms: 2, builtSqm: 120,
    amenities: ['SECURITY_24H', 'SECURITY_GATED', 'SECURITY_GATED', 'PARKING', 'BALCONY'],
    negotiable: true, publishedDaysAgo: 5, views: 640, photos: 4,
  },
  {
    poster: 5, area: 'Gwarinpa', kind: ListingKind.RENT, type: 'ROOM_2',
    title: 'Clean 2-room flat sharing in Gwarinpa Estate',
    description:
      'Spacious 2-room in a quiet block, sharing with two tidy housemates. Water and security are handled by the estate. Suitable for a working professional or a couple.',
    price: 450_000, pricePeriod: PricePeriod.MONTHLY,
    amenities: ['SECURITY_24H', 'SECURITY_GATED', 'WATER_SUPPLY'],
    publishedDaysAgo: 2, views: 410, photos: 3,
  },
  {
    poster: 2, area: 'Yaba', kind: ListingKind.RENT, type: 'SELF_CONTAIN_1',
    title: 'Bright self-contain above a shop in Yaba',
    description:
      'A one-room self-contain with its own entrance above a bakery, on a busy Yaba street. Water is included; power is metered separately.',
    price: 300_000, pricePeriod: PricePeriod.MONTHLY,
    amenities: ['WATER_SUPPLY'],
    publishedDaysAgo: 8, views: 275, photos: 2,
  },
  {
    poster: 7, area: 'Maryland', kind: ListingKind.RENT, type: 'BUNK',
    title: 'Bunk space in a mixed student flat, Maryland',
    description:
      'One bunk space in a four-person student flat, about eight minutes walk to the Maryland bus stop. Rent includes water and security.',
    price: 150_000, pricePeriod: PricePeriod.MONTHLY,
    amenities: ['WATER_SUPPLY', 'SECURITY_GATED'],
    publishedDaysAgo: 20, views: 190, photos: 2,
  },
  {
    poster: 4, area: 'Asokoro Extension', kind: ListingKind.SALE, type: 'LAND',
    title: '2 plots of 600sqm in Asokoro Extension, C of O',
    description:
      'Two adjoining plots totalling 1,200sqm in a developing estate in Asokoro Extension. The road is already tarred and there is electricity on the pole. Certificate of occupancy is available.',
    price: 48_000_000, pricePeriod: PricePeriod.NONE,
    plotSqm: 1200,
    amenities: ['SECURITY_GATED', 'SERVICED'],
    deedType: DeedType.COFO, titleVerified: true,
    publishedDaysAgo: 6, views: 1180, photos: 3,
  },
  {
    poster: 1, area: 'Wuse 2', kind: ListingKind.RENT, type: 'OFFICE_SPACE',
    title: 'Serviced office space on the 3rd floor, Wuse 2',
    description:
      'A serviced office suite with reception, boardroom access and reliable power. The building is occupied by a mix of consulting and technology firms. One year lease minimum.',
    price: 6_500_000, pricePeriod: PricePeriod.YEARLY,
    builtSqm: 260,
    amenities: ['SECURITY_24H', 'LIFT', 'SECURITY_GATED', 'PARKING', 'GYM'],
    publishedDaysAgo: 30, views: 520, photos: 3,
  },
  {
    poster: 0, area: 'Maitama', kind: ListingKind.SALE, type: 'TERRACED_HOUSE',
    title: '4-bedroom terrace in Maitama, estate still available',
    description:
      'A four-bedroom terrace in a small, well-run estate in Maitama. All rooms are en-suite, and there is a shared green at the back. A few units remain.',
    price: 320_000_000, pricePeriod: PricePeriod.NONE,
    bedrooms: 4, bathrooms: 4, builtSqm: 280,
    amenities: ['SECURITY_GATED', 'SECURITY_24H', 'SECURITY_GATED', 'GARDEN', 'PARKING'],
    deedType: DeedType.DEED_OF_ASSIGNMENT, titleVerified: true, hasVideo: true,
    publishedDaysAgo: 2, views: 1620, photos: 5,
  },
  {
    poster: 3, area: 'Lekki Phase 1', kind: ListingKind.RENT, type: 'BUNGALOW',
    title: '3-bedroom bungalow to let, Lekki Phase 1',
    description:
      'A detached bungalow on a paved street in Lekki Phase 1, with a fenced compound and a BQ. Suitable for a small family or a company representative office.',
    price: 6_000_000, pricePeriod: PricePeriod.YEARLY,
    bedrooms: 3, bathrooms: 4, plotSqm: 600, builtSqm: 210,
    amenities: ['SECURITY_GATED', 'SECURITY_24H', 'SECURITY_GATED', 'BOYS_QUARTERS', 'GARDEN', 'PARKING'],
    publishedDaysAgo: 15, views: 730, photos: 4,
  },
  {
    poster: 6, area: 'Egbeda', kind: ListingKind.RENT, type: 'ROOM_3',
    title: '3-room flat in Egbeda, quiet close to the market',
    description:
      'A three-room flat in a compound a few minutes from Egbeda market and the bus stop. Ground floor unit, currently empty and ready to move in.',
    price: 550_000, pricePeriod: PricePeriod.MONTHLY,
    amenities: ['WATER_SUPPLY', 'SECURITY_GATED'],
    negotiable: true, publishedDaysAgo: 4, views: 385, photos: 3,
  },
  {
    poster: 5, area: 'Surulere', kind: ListingKind.RENT, type: 'SELF_CONTAIN_1',
    title: 'Neat self-contain in Surulere, off the main road',
    description:
      'A well kept one-room self-contain in a compound, with parking for one car. Quiet at night despite the central location.',
    price: 280_000, pricePeriod: PricePeriod.MONTHLY,
    amenities: ['WATER_SUPPLY', 'PARKING'],
    publishedDaysAgo: 25, views: 240, photos: 2,
  },
  {
    poster: 1, area: 'Jabi', kind: ListingKind.SALE, type: 'SHOP',
    title: 'Double-storey commercial building with 6 shops, Jabi',
    description:
      'A double-storey commercial building with six let shops and a spacious parking area in front. Currently fully tenanted, making it an income-producing asset. Sits on the main Jabi road.',
    price: 145_000_000, pricePeriod: PricePeriod.NONE,
    plotSqm: 800, builtSqm: 950,
    amenities: ['SECURITY_GATED', 'PARKING', 'SECURITY_GATED'],
    deedType: DeedType.REGISTRY,
    publishedDaysAgo: 9, views: 1440, photos: 4,
  },
  {
    poster: 4, area: 'Alaba', kind: ListingKind.RENT, type: 'COMMERCIAL',
    title: 'Open-front shop space to let, Alaba market area',
    description:
      'A wide open-front shop with a small storage area, suitable for fashion or provisions. Foot traffic is high all day. Would suit a serious trader.',
    price: 2_400_000, pricePeriod: PricePeriod.YEARLY,
    builtSqm: 45,
    amenities: ['SECURITY_GATED'],
    publishedDaysAgo: 18, views: 460, photos: 3,
  },
  {
    poster: 7, area: 'Lugbe', kind: ListingKind.SALE, type: 'LAND',
    title: '1 plot, 300sqm in Lugbe, title documents available',
    description:
      'A single residential plot in a growing area of Lugbe. The road network is being graded and the immediate neighbours have begun building. Popular with first-time buyers.',
    price: 9_500_000, pricePeriod: PricePeriod.NONE,
    plotSqm: 300,
    amenities: [],
    deedType: DeedType.SURVEY,
    publishedDaysAgo: 40, views: 890, photos: 2,
  },
  {
    poster: 0, area: 'Ikoyi', kind: ListingKind.RENT, type: 'FLAT_APARTMENT',
    title: 'Executive 3-bedroom flat, Ikoyi GRA',
    description:
      'An executive three-bedroom flat on the third floor of a well-run block. Finished to a high standard, with a fitted kitchen, walk-in wardrobe and a covered parking bay.',
    price: 8_000_000, pricePeriod: PricePeriod.YEARLY,
    bedrooms: 3, bathrooms: 3, builtSqm: 200,
    amenities: ['SECURITY_24H', 'LIFT', 'SECURITY_GATED', 'SECURITY_GATED', 'PARKING', 'GYM', 'SWIMMING_POOL'],
    publishedDaysAgo: 1, views: 980, photos: 5,
  },
  {
    poster: 6, area: 'Victoria Island', kind: ListingKind.SALE, type: 'COMMERCIAL',
    title: 'Office tower floor plate, Victoria Island',
    description:
      'A full floor plate in a modern office tower on the Marina, suitable for a corporate headquarters. Serviced reception, two lifts and dedicated generator.',
    price: 1_450_000_000, pricePeriod: PricePeriod.NONE,
    builtSqm: 1400,
    amenities: ['SECURITY_24H', 'LIFT', 'SECURITY_GATED', 'PARKING', 'SECURITY_GATED'],
    deedType: DeedType.COFO, titleVerified: true,
    publishedDaysAgo: 55, views: 3100, photos: 4,
  },
  {
    poster: 5, area: 'Maryland', kind: ListingKind.RENT, type: 'MINI_FLAT',
    title: 'Studio mini flat, Maryland, bills partly included',
    description:
      'A compact studio with an open kitchenette in a gated block. Water and security are included in the rent; power is prepaid by the tenant.',
    price: 380_000, pricePeriod: PricePeriod.MONTHLY,
    amenities: ['WATER_SUPPLY', 'SECURITY_GATED', 'SECURITY_GATED'],
    publishedDaysAgo: 7, views: 305, photos: 3,
  },
  {
    poster: 3, area: 'Wuse 2', kind: ListingKind.RENT, type: 'FLAT_APARTMENT',
    title: '2-bedroom flat in Wuse 2, close to the market',
    description:
      'A two-bedroom flat on the second floor, a short walk from Wuse 2 market. Clean, quiet and immediately available.',
    price: 900_000, pricePeriod: PricePeriod.MONTHLY,
    bedrooms: 2, bathrooms: 2,
    amenities: ['SECURITY_24H', 'SECURITY_GATED', 'PARKING'],
    publishedDaysAgo: 11, views: 540, photos: 3,
  },

  // ---------------------------------------------------------------------
  // Second wave.
  //
  // The first wave alone left the browse page looking thin and, more
  // importantly, could not exercise the filters: there were only 18 distinct
  // titles across 16 prices and 13 areas, so sorting by price or filtering by
  // area produced visibly wrong-looking results.
  //
  // Every entry below deliberately differs from every other in title, price,
  // area and type, so the page reads as a real market rather than one listing
  // repeated. Prices are drawn from the actual ranges people post at in each
  // area, because an Ikoyi flat priced like a Surulere self-contain is the sort
  // of thing that makes a Nigerian user stop trusting the whole site.
  // ---------------------------------------------------------------------

  // Uses the canonical spec name. "GRA Ikeja" exists as an alias row in the
  // database from an earlier run but is not a key in the AREAS spec, so naming
  // it here skips the listing with "missing area". The seed validates this now
  // rather than failing halfway through.
  { poster: 1, area: 'Ikeja GRA', kind: ListingKind.RENT, type: 'FLAT_APARTMENT',
    title: 'Renovated 3-bedroom flat with BQ in Ikeja GRA',
    description:
      'Newly painted and tiled three-bedroom flat on the third floor, with a self-contained BQ. Windows are grilled, water runs all day, and there is a dedicated parking bay for one car. Landlord lives on site and is easy to reach.',
    price: 1_450_000, pricePeriod: PricePeriod.YEARLY,
    bedrooms: 3, bathrooms: 3, builtSqm: 145,
    amenities: ['SECURITY_GATED', 'SECURITY_24H', 'WATER_SUPPLY', 'PARKING', 'BOYS_QUARTERS'],
    publishedDaysAgo: 2, views: 1120, photos: 5 },

  { poster: 4, area: 'Ikeja GRA', kind: ListingKind.SALE, type: 'TERRACED_HOUSE',
    title: '4-bedroom terrace with rooftop terrace, Ikeja GRA',
    description:
      'A four-bedroom terrace in a small, quiet close off Oduduwa Way. All rooms are en-suite, and there is a shared rooftop terrace. The estate has a functional borehole, a gated entrance and a community guard. Genuine occupants, priced to sell.',
    price: 310_000_000, pricePeriod: PricePeriod.NONE,
    bedrooms: 4, bathrooms: 4, plotSqm: 420, builtSqm: 280,
    amenities: ['SECURITY_GATED', 'SECURITY_24H', 'BALCONY', 'WATER_SUPPLY', 'PARKING'],
    deedType: DeedType.COF, titleVerified: true,
    publishedDaysAgo: 6, views: 2760, photos: 6 },

  { poster: 2, area: 'Yaba', kind: ListingKind.RENT, type: 'COMMERCIAL',
    title: 'Office suite above a bank, Yaba',
    description:
      'A fitted office suite on the first floor of a commercial building, with a dedicated entrance, air conditioning, and two parking spaces. Suitable for a small team or a single professional. Service charge is included.',
    price: 1_800_000, pricePeriod: PricePeriod.YEARLY,
    builtSqm: 85,
    amenities: ['SECURITY_24H', 'INVERTER', 'SERVICED', 'PARKING'],
    publishedDaysAgo: 4, views: 760, photos: 4 },

  { poster: 6, area: 'Maryland', kind: ListingKind.RENT, type: 'ROOM_2',
    title: 'Spacious 2-room flat sharing, Maryland',
    description:
      'A large shared 2-room flat with a generous compound and reliable water. One housemate, a civil servant, quiet and tidy. The room comes with a wardrobe, a bed frame and a reading desk. Utility bills are split between the two of you.',
    price: 320_000, pricePeriod: PricePeriod.YEARLY,
    amenities: ['WATER_SUPPLY', 'PARKING', 'BALCONY'],
    publishedDaysAgo: 8, views: 1290, photos: 4 },

  { poster: 5, area: 'Surulere', kind: ListingKind.RENT, type: 'SELF_CONTAIN_1',
    title: 'Modern self-contain in Surulere, own compound',
    description:
      'A newer self-contained unit in a small compound with a shared laundry area and water storage. Off the main road, so it is quiet, but still within easy reach of the rail line. Advance and two years rent.',
    price: 400_000, pricePeriod: PricePeriod.YEARLY,
    bedrooms: 1, bathrooms: 1,
    amenities: ['WATER_SUPPLY', 'SECURITY_GATED'],
    publishedDaysAgo: 5, views: 980, photos: 4 },

  { poster: 7, area: 'Egbeda', kind: ListingKind.RENT, type: 'BUNGALOW',
    title: '3-room bungalow with a big yard, Egbeda',
    description:
      'A three-room bungalow in a family compound, with a large rear yard suitable for a second bar or a small garden. Two cars park comfortably. The compound is peaceful and the neighbours are quiet.',
    price: 700_000, pricePeriod: PricePeriod.YEARLY,
    bedrooms: 3, bathrooms: 2, plotSqm: 400,
    amenities: ['GARDEN', 'PARKING', 'WATER_SUPPLY', 'FENCED'],
    publishedDaysAgo: 14, views: 1420, photos: 5 },

  { poster: 0, area: 'Lekki Phase 2', kind: ListingKind.SALE, type: 'DUPLEX',
    title: '5-bedroom duplex with maid quarters, Lekki Phase 2',
    description:
      'A five-bedroom duplex over three floors in a family estate off Admiralty Way. Includes a two-room maid quarters, a fitted kitchen, and an open parking space for two cars. The estate is still in use, so this is not an abandoned shell.',
    price: 395_000_000, pricePeriod: PricePeriod.NONE,
    bedrooms: 5, bathrooms: 5, plotSqm: 650, builtSqm: 410,
    amenities: ['SECURITY_GATED', 'SECURITY_24H', 'PARKING', 'BOYS_QUARTERS', 'BALCONY', 'WATER_SUPPLY'],
    deedType: DeedType.DEED_OF_ASSIGNMENT, titleVerified: true,
    publishedDaysAgo: 9, views: 3980, photos: 6 },

  { poster: 3, area: 'Maitama', kind: ListingKind.RENT, type: 'OFFICE_SPACE',
    title: '1,200sqm office space to let, Maitama',
    description:
      'A full floor of office space in a Maitama office building, with a lift, generator, and parking for staff. Fitted to an open-plan layout with a boardroom and two offices. Suitable for an expanding team. Quoted annually, with a two-year lease preferred.',
    price: 28_000_000, pricePeriod: PricePeriod.YEARLY,
    builtSqm: 1200,
    amenities: ['LIFT', 'SECURITY_24H', 'PARKING', 'INVERTER', 'SERVICED', 'GENERATOR'],
    publishedDaysAgo: 7, views: 1640, photos: 5 },

  { poster: 5, area: 'Jabi', kind: ListingKind.SALE, type: 'WAREHOUSE',
    title: 'Warehouse with 3 loading bays, Jabi',
    description:
      'A 900sqm warehouse with three loading bays and a small office block. Ceiling height is sufficient for stacked pallets, and there is room to manoeuvre a truck inside the compound. Sold with a clean title.',
    price: 165_000_000, pricePeriod: PricePeriod.NONE,
    plotSqm: 1200, builtSqm: 900,
    amenities: ['SECURITY_GATED', 'SECURITY_24H', 'PARKING'],
    deedType: DeedType.COFO, titleVerified: true,
    publishedDaysAgo: 16, views: 1180, photos: 5 },

  { poster: 1, area: 'Kuje', kind: ListingKind.SALE, type: 'LAND',
    title: '2 plots of 500sqm, Kuje, off the airport road',
    description:
      'Two adjoining plots in a developing estate, about fifteen minutes from the airport road. The road is graded and electricity is on the pole line. Popular with buyers building to own, and priced per plot.',
    price: 14_000_000, pricePeriod: PricePeriod.NONE,
    plotSqm: 1000,
    amenities: ['PAVED_ROAD', 'FENCED'],
    deedType: DeedType.SURVEY, titleVerified: true,
    publishedDaysAgo: 20, views: 2210, photos: 4 },

  { poster: 2, area: 'Alaba', kind: ListingKind.RENT, type: 'SHOP',
    title: 'Double shop unit with rear store, Alaba',
    description:
      'A double shop unit in a busy trading area, with a rear store and a toilet. Suitable for a retailer or a pharmacy. Rent is quoted annually and includes a service charge.',
    price: 5_400_000, pricePeriod: PricePeriod.YEARLY,
    amenities: ['SECURITY_GATED', 'SECURITY_24H'],
    publishedDaysAgo: 13, views: 1890, photos: 4 },

  { poster: 6, area: 'Gwarinpa', kind: ListingKind.SALE, type: 'BLOCK_OF_FLATS',
    title: '12-unit residential block for sale, Gwarinpa',
    description:
      'A completed twelve-unit block, each a one-bedroom flat, currently tenanted. Incoming rent is documented and the buyer inherits the tenancy, which makes the income immediate rather than promised.',
    price: 420_000_000, pricePeriod: PricePeriod.NONE,
    plotSqm: 800, builtSqm: 950,
    amenities: ['SECURITY_GATED', 'SECURITY_24H', 'PARKING', 'GYM'],
    deedType: DeedType.DEED_OF_ASSIGNMENT, titleVerified: true,
    publishedDaysAgo: 10, views: 2640, photos: 6 },

  { poster: 7, area: 'Asokoro Extension', kind: ListingKind.RENT, type: 'MINI_FLAT',
    title: 'Serviced studio mini flat, Asokoro Extension',
    description:
      'A serviced studio with monthly power, water, wifi and weekly cleaning included in the rent. Good for a professional on relocation, or anyone who does not want to sign a long lease.',
    price: 950_000, pricePeriod: PricePeriod.MONTHLY,
    bedrooms: 1, bathrooms: 1,
    amenities: ['FURNISHED', 'SECURITY_24H', 'GYM', 'SWIMMING_POOL', 'LIFT'],
    publishedDaysAgo: 1, views: 1040, photos: 5, hasVideo: true },
];

// ---------------------------------------------------------------------------
// Placeholder image generation
// ---------------------------------------------------------------------------

/**
 * Calm, architectural palettes.
 *
 * Deliberately desaturated and cool. These sit behind real estate photography in
 * a grid, so anything with strong colour competes with the listings that have
 * genuine photos. The goal is a frame the eye rests on, not one that pulls it.
 */
const PALETTES: Array<[string, string, string]> = [
  ['#2f4858', '#4a6b7c', '#1b2c38'],
  ['#33564a', '#527f6d', '#1e3229'],
  ['#4a3f52', '#6d5c76', '#2a2330'],
  ['#54463a', '#7d6a55', '#322a22'],
  ['#2e4a5c', '#456b80', '#1a2b36'],
  ['#3f4a3c', '#5f7059', '#252d24'],
  ['#4d3f42', '#74595d', '#2c2527'],
  ['#3a4450', '#576475', '#222a32'],
];

/**
 * Category glyph drawn on the placeholder.
 *
 * A short piece of information beats decoration. A viewer scanning a grid learns
 * that this is a shop, that is a flat, that is land, before reading a single
 * word, which is the one genuinely useful thing a placeholder can do.
 */
type Category = 'tower' | 'house' | 'land' | 'commercial';

function categoryFor(type: string): Category {
  if (type === 'LAND' || type === 'LAND_LEASE') return 'land';
  if (
    type === 'SHOP' ||
    type === 'WAREHOUSE' ||
    type === 'COMMERCIAL' ||
    type === 'OFFICE_SPACE' ||
    type === 'COWORKING_SPACE'
  ) {
    return 'commercial';
  }
  if (
    type === 'BLOCK_OF_FLATS' ||
    type === 'FLAT_APARTMENT' ||
    type === 'MINI_FLAT' ||
    type === 'SHARED_APARTMENT'
  ) {
    return 'tower';
  }
  return 'house';
}

/**
 * Draws the placeholder frame.
 *
 * This was three successive attempts at a generated photograph, and each one was
 * worse than admitting there is no photograph. Rendering a building out of
 * rectangles produced something that read as amateur vector art, and adding
 * atmospheric effects on top (haze, vignette, bloom, grain) drove every value in
 * the frame toward the same mid-tone, so the whole grid came out as beige fog.
 *
 * So it no longer pretends. The frame is a considered gradient with a soft light
 * source, a single category glyph and a fine grain. That reads as deliberate
 * design rather than as a failed image, which is the standard a placeholder
 * should be held to. A viewer is not misled about what they are looking at, and
 * the card is pleasant to look at while the demo dataset is still image-less.
 */
async function generateFacade(
  index: number,
  width: number,
  height: number,
  type = 'FLAT_APARTMENT',
): Promise<Buffer> {
  const [base, mid, dark] = PALETTES[index % PALETTES.length];
  const category = categoryFor(type);

  // Deterministic in `index`, so re-seeding produces byte-identical images.
  const jitter = (salt: number) => ((index * 9301 + salt * 49297) % 233280) / 233280;

  const glyph = buildCategoryGlyph(category, width, height);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <!--
        Diagonal rather than vertical. A vertical ramp puts a hard band across
        the middle of a wide card, which is exactly where the price and title
        sit, so the type lands on the lightest part of the frame. The diagonal
        keeps the upper-left dark and the lower-right light, which is the
        conventional direction for light in a photograph.
      -->
      <linearGradient id="field" x1="0" y1="0" x2="0.85" y2="1">
        <stop offset="0%" stop-color="${dark}"/>
        <stop offset="55%" stop-color="${base}"/>
        <stop offset="100%" stop-color="${mid}"/>
      </linearGradient>

      <!-- Light source, kept weak. At higher opacity it turned into a visible
           disc, which is a tell that the frame is drawn. -->
      <radialGradient id="glow" cx="0.74" cy="0.24" r="0.6">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.14"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>

      <radialGradient id="vig" cx="0.5" cy="0.45" r="0.82">
        <stop offset="60%" stop-color="#000" stop-opacity="0"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0.22"/>
      </radialGradient>
    </defs>

    <rect width="${width}" height="${height}" fill="url(#field)"/>
    <rect width="${width}" height="${height}" fill="url(#glow)"/>

    <!--
      Soft depth shapes. Very low opacity on purpose: these are meant to be
      felt rather than seen. At anything above a few percent they read as
      distinct ellipses laid over the gradient, which looks like a mistake.
    -->
    <ellipse cx="${(width * (0.2 + jitter(3) * 0.2)).toFixed(0)}" cy="${(height * 0.78).toFixed(0)}"
             rx="${(width * 0.62).toFixed(0)}" ry="${(height * 0.6).toFixed(0)}"
             fill="#ffffff" opacity="0.022"/>
    <ellipse cx="${(width * (0.78 - jitter(7) * 0.2)).toFixed(0)}" cy="${(height * 0.18).toFixed(0)}"
             rx="${(width * 0.56).toFixed(0)}" ry="${(height * 0.52).toFixed(0)}"
             fill="#000000" opacity="0.03"/>

    ${glyph}

    <rect width="${width}" height="${height}" fill="url(#vig)"/>
  </svg>`;

  const composed = sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer();

  // Fine grain, composited with `soft-light`. This breaks up the banding that
  // wide gradients show on 8-bit displays, which is the one real artifact here.
  // `overlay` was tried first and lifted the blacks far too much.
  const grain = await sharp({
    create: {
      width,
      height,
      channels: 3,
      noise: { type: 'gaussian', mean: 128, sigma: 6 },
    },
  })
    .webp({ quality: 100, alphaQuality: 0 })
    .toBuffer();

  return sharp(await composed)
    .composite([{ input: await grain, blend: 'soft-light' }])
    .webp({ quality: 82 })
    .toBuffer();
}

/**
 * Builds the outline glyph for a category.
 *
 * Stroke only, no fill, at low opacity. A filled shape at this size competes
 * with the card text; a thin outline sits behind it and reads as a watermark.
 */
function buildCategoryGlyph(category: Category, width: number, height: number): string {
  // Sized off the smaller dimension so the glyph is the same visual weight in a
  // 4:3 cover and a square gallery image.
  const s = Math.min(width, height) * 0.42;
  const cx = width / 2;
  const cy = height / 2;
  const stroke = '#ffffff';
  const sw = Math.max(2, Math.round(s * 0.035));

  const open = (d: string) =>
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-opacity="0.2" ` +
    `stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;

  const u = s / 2; // half-extent

  switch (category) {
    case 'tower':
      // Two stacked blocks, reads as a multi-storey building.
      return (
        open(`M ${cx - u * 0.95} ${cy + u} L ${cx - u * 0.95} ${cy - u * 0.15} L ${cx + u * 0.1} ${cy - u * 0.15} L ${cx + u * 0.1} ${cy + u}`) +
        open(`M ${cx - u * 0.55} ${cy + u} L ${cx - u * 0.55} ${cy - u} L ${cx + u * 0.95} ${cy - u} L ${cx + u * 0.95} ${cy + u}`) +
        // Window rows, so it reads as a building rather than as two rectangles.
        open(`M ${cx - u * 0.32} ${cy - u * 0.62} L ${cx + u * 0.72} ${cy - u * 0.62}`) +
        open(`M ${cx - u * 0.32} ${cy - u * 0.05} L ${cx + u * 0.72} ${cy - u * 0.05}`) +
        open(`M ${cx - u * 0.32} ${cy + u * 0.52} L ${cx + u * 0.72} ${cy + u * 0.52}`)
      );

    case 'house':
      // Pitched roof over a body, with a door.
      return (
        open(`M ${cx - u} ${cy - u * 0.05} L ${cx} ${cy - u} L ${cx + u} ${cy - u * 0.05}`) +
        open(`M ${cx - u * 0.78} ${cy - u * 0.05} L ${cx - u * 0.78} ${cy + u} L ${cx + u * 0.78} ${cy + u} L ${cx + u * 0.78} ${cy - u * 0.05}`) +
        open(`M ${cx - u * 0.2} ${cy + u} L ${cx - u * 0.2} ${cy + u * 0.28} L ${cx + u * 0.2} ${cy + u * 0.28} L ${cx + u * 0.2} ${cy + u}`)
      );

    case 'land':
      // Survey plot corner markers, unmistakable for land.
      return (
        open(`M ${cx - u} ${cy - u * 0.8} L ${cx - u} ${cy + u * 0.8} L ${cx + u} ${cy + u * 0.8} L ${cx + u} ${cy - u * 0.8}`) +
        open(`M ${cx - u} ${cy - u * 0.8} L ${cx + u} ${cy + u * 0.8}`) +
        open(`M ${cx - u * 0.55} ${cy - u * 0.34} L ${cx - u * 0.16} ${cy - u * 0.34} L ${cx - u * 0.16} ${cy + u * 0.14}`)
      );

    case 'commercial':
      // Shopfront: fascia over a wide opening, with an awning line.
      return (
        open(`M ${cx - u} ${cy - u * 0.55} L ${cx + u} ${cy - u * 0.55} L ${cx + u} ${cy - u * 0.2} L ${cx - u} ${cy - u * 0.2} Z`) +
        open(`M ${cx - u * 0.85} ${cy + u} L ${cx - u * 0.85} ${cy - u * 0.2} L ${cx + u * 0.85} ${cy - u * 0.2} L ${cx + u * 0.85} ${cy + u}`) +
        open(`M ${cx - u * 0.2} ${cy + u} L ${cx - u * 0.2} ${cy + u * 0.35} L ${cx + u * 0.2} ${cy + u * 0.35} L ${cx + u * 0.2} ${cy + u}`)
      );
  }
}
/** Small dark tile used as the video poster in the demo dataset. */
async function generateVideoPoster(width: number, height: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#22303a"/>
    <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) * 0.13}" fill="#ffffff" opacity="0.9"/>
    <path d="M ${width / 2 - 14} ${height / 2 - 20} L ${width / 2 + 24} ${height / 2} L ${width / 2 - 14} ${height / 2 + 20} Z" fill="#22303a"/>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 70 }).toBuffer();
}

/**
 * Listings sitting in the review queue.
 *
 * The live dataset alone would leave the admin console's most important screen
 * empty, which makes it impossible to tell whether the queue works. These cover
 * the decision cases a moderator actually faces: a clean approval, a scam signal
 * that should block, a price that is off by an order of magnitude, a missing
 * title document on land, and one that has already breached the 6-hour SLA.
 */
interface QueueSpec {
  poster: number;
  area: string;
  kind: ListingKind;
  type: string;
  title: string;
  description: string;
  price: number;
  pricePeriod: PricePeriod;
  plotSqm?: number;
  amenities: string[];
  deedType?: DeedType;
  signal?: { signal: string; severity: 'INFO' | 'WARN' | 'BLOCK'; source: string; detail: Record<string, unknown> };
  /** Hours since submission. 8+ is past the escalation threshold. */
  waitingHours: number;
}

const QUEUE: QueueSpec[] = [
  {
    poster: 5, area: 'Lekki Phase 1', kind: 'RENT', type: 'FLAT_APARTMENT',
    title: 'Tidy 2-bedroom flat in a gated Lekki Phase 1 block',
    description:
      'Second floor flat with a covered car park, fitted kitchen and a quiet compound. Water is from the estate treatment plant; power is a prepaid meter. Available from the first of next month.',
    price: 4_200_000, pricePeriod: PricePeriod.YEARLY,
    amenities: ['SECURITY_24H', 'SECURITY_GATED', 'SECURITY_GATED', 'PARKING'],
    waitingHours: 0.4,
  },
  {
    poster: 2, area: 'Surulere', kind: 'SALE', type: 'DETACHED_HOUSE',
    title: 'Cheap 6-bedroom house with pool, Surulere, urgent sale',
    description:
      'CALL 0803 555 0199 or WhatsApp the same number for more pictures and a discount. Genuine buyer only, agent fees negotiable, must sell fast this month. Send your number and I will call you back immediately.',
    price: 12_000_000, pricePeriod: PricePeriod.NONE,
    amenities: ['SWIMMING_POOL', 'PARKING'],
    signal: {
      signal: 'CONTACT_IN_BODY',
      severity: 'BLOCK',
      source: 'auto-moderation',
      detail: {
        matched: ['0803 555 0199'],
        note: 'Phone number in description defeats the reveal gate and is the primary scam vector.',
      },
    },
    waitingHours: 2.5,
  },
  {
    poster: 7, area: 'Egbeda', kind: 'SALE', type: 'LAND',
    title: '500sqm plot at a bargain price, Egbeda, titles available',
    description:
      'Very cheap land, better price than anywhere in Egbeda. Documents can be sorted after payment. Located close to the expressway, a good investment for a young person just starting out.',
    price: 750_000, pricePeriod: PricePeriod.NONE,
    plotSqm: 500,
    amenities: [],
    // A declared title type, but no document was uploaded. This is the realistic
    // shape of the risk: the poster names a document rather than omitting the
    // field. `deed_type = NONE` is not reachable here at all — the land-deed
    // trigger rejects it, which is the protection doing its job.
    deedType: DeedType.SURVEY,
    signal: {
      signal: 'TITLE_DOC_MISSING',
      severity: 'BLOCK',
      source: 'auto-moderation',
      detail: { note: 'Land listing claiming a survey but uploading no title document. Do not approve without registry verification.' },
    },
    waitingHours: 1.2,
  },
  {
    poster: 1, area: 'Victoria Island', kind: 'SALE', type: 'LAND',
    title: 'Half plot of land, Victoria Island, asking 1.5 billion',
    description:
      'Half a plot on the Marina. Suitable for a corporate office or a mixed-use development once the structure is approved. Flexible on price for a serious buyer.',
    price: 1_500_000_000, pricePeriod: PricePeriod.NONE,
    plotSqm: 300,
    amenities: ['SECURITY_GATED'],
    deedType: DeedType.COFO,
    signal: {
      signal: 'PRICE_OUTLIER',
      severity: 'WARN',
      source: 'auto-moderation',
      detail: {
        medianForType: 480_000_000,
        multiple: 3.1,
        note: 'Over 3x the median for this type and area. Verify the size and the title before approving.',
      },
    },
    waitingHours: 5,
  },
  {
    poster: 4, area: 'Maryland', kind: 'RENT', type: 'ROOM_SINGLE',
    title: 'Single room for rent, Maryland',
    description:
      'A single room in a shared flat. Water is included, electricity is shared. Call the owner or send a message through the app for more information and to arrange a viewing.',
    price: 120_000, pricePeriod: PricePeriod.MONTHLY,
    amenities: ['WATER_SUPPLY'],
    waitingHours: 9,
  },
  {
    poster: 3, area: 'Jabi', kind: 'RENT', type: 'OFFICE_SPACE',
    title: 'Open-plan office space, Jabi, suitable for a small team',
    description:
      'An open-plan office that seats about twelve, with two small meeting rooms and a reception. The building has a lift and a dedicated generator. Two-year lease available.',
    price: 14_400_000, pricePeriod: PricePeriod.YEARLY,
    amenities: ['SECURITY_24H', 'LIFT', 'SECURITY_GATED', 'PARKING'],
    waitingHours: 3.5,
  },
];

async function seedReviewQueue(
  areaIds: Map<string, string>,
  posterIds: string[],
  agencyIds: Array<string | null>,
  pii: { encrypt: (plain: string) => string; blindIndex: (plain: string) => string },
): Promise<number> {
  let queued = 0;
  let imageIndex = 900;

  for (const spec of QUEUE) {
    const areaId = areaIds.get(spec.area);
    const posterId = posterIds[spec.poster];
    if (!areaId || !posterId) {
      console.warn(`  skip queue item "${spec.title}": missing area or poster`);
      continue;
    }

    const norm = normName(spec.title);
    const existing = await prisma.listing.findFirst({
      where: { posterId, titleNorm: norm },
      select: { id: true },
    });
    if (existing) continue;

    const submittedAt = new Date(Date.now() - spec.waitingHours * 3_600_000);
    const area = await prisma.area.findUniqueOrThrow({
      where: { id: areaId },
      select: { stateCode: true, lgaId: true },
    });

    const listing = await prisma.listing.create({
      data: {
        kindCode: spec.kind,
        typeCode: spec.type,
        stateCode: area.stateCode,
        lgaId: area.lgaId,
        areaId,
        exactAddressEnc: pii.encrypt('Behind the old market, ' + spec.area + ' (viewing by arrangement)'),
        title: spec.title,
        titleNorm: norm,
        description: spec.description,
        price: BigInt(spec.price),
        pricePeriod: spec.pricePeriod,
        plotSqm: spec.plotSqm ?? null,
        // Deduped: mapping the old shorthand onto the vocabulary can collapse two
    // codes onto one (SECURITY and GATED both became SECURITY_GATED), and a
    // repeated code would render as a duplicated chip.
    amenities: [...new Set(spec.amenities)],
        deedType: spec.deedType ?? DeedType.NONE,
        posterId,
        agencyId: agencyIds[spec.poster],
        status: 'PENDING_REVIEW',
        submittedAt,
        // Mirrors the real policy: target 3h, escalate 6h.
        slaDueAt: new Date(submittedAt.getTime() + 3 * 3_600_000),
      },
      select: { id: true },
    });

    await prisma.listingReviewEvent.create({
      data: {
        listingId: listing.id,
        actorId: posterId,
        action: 'SUBMITTED',
        note: 'Submitted by the poster',
      },
    });

    if (spec.signal) {
      await prisma.moderationSignal.create({
        data: {
          listingId: listing.id,
          signal: spec.signal.signal as never,
          severity: spec.signal.severity,
          source: spec.signal.source,
          detail: spec.signal.detail as never,
        },
      });
    }

    // Two images so the queue's media strip is exercised.
    for (let p = 0; p < 2; p += 1) {
      const width = 1280;
      const height = p === 0 ? 854 : 1280;
      const bytes = await generateFacade(imageIndex, width, height, spec.type);
      imageIndex += 1;

      // The asset row must exist before the key can be derived from its id, so
      // create it as UPLOADING, store the bytes, then mark it READY. That is the
      // same order the real pipeline uses.
      const asset = await prisma.mediaAsset.create({
        data: {
          ownerId: posterId,
          kind: 'IMAGE',
          status: 'UPLOADING',
          mime: 'image/webp',
          bytes: BigInt(bytes.byteLength),
          width,
          height,
          moderationStatus: 'CLEAR',
          exifStripped: true,
        },
        select: { id: true },
      });

      const storageKey = await storeDemoImage(asset.id, bytes);

      await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          status: 'READY',
          storageKey,
          compressedBytes: BigInt(bytes.byteLength),
          readyAt: submittedAt,
        },
      });

      await prisma.listingMedia.create({
        data: { listingId: listing.id, mediaAssetId: asset.id, isCover: p === 0, position: p },
      });
    }

    queued += 1;
  }

  return queued;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function normName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(name: string): string {
  return normName(name).replace(/\s+/g, '-');
}

async function upsertAreas(): Promise<Map<string, string>> {
  const byName = new Map<string, string>();

  for (const spec of AREAS) {
    const lga = await prisma.lga.findFirst({
      where: { stateCode: spec.state, name: spec.lga },
      select: { id: true },
    });
    if (!lga) {
      console.warn(`  skip area ${spec.name}: LGA ${spec.lga}/${spec.state} not in seed data`);
      continue;
    }

    const area = await prisma.area.upsert({
      where: { lgaId_normName: { lgaId: lga.id, normName: normName(spec.name) } },
      update: { isActive: true, centreLat: spec.lat, centreLng: spec.lng },
      create: {
        name: spec.name,
        slug: slugify(spec.name),
        normName: normName(spec.name),
        lgaId: lga.id,
        stateCode: spec.state,
        centreLat: spec.lat,
        centreLng: spec.lng,
        isActive: true,
      },
      select: { id: true },
    });

    for (const alias of spec.aliases) {
      const aliasNorm = normName(alias);
      if (aliasNorm === normName(spec.name)) continue;
      const existing = await prisma.areaAlias.findFirst({
        where: { areaId: area.id, normAlias: aliasNorm },
        select: { id: true },
      });
      if (!existing) {
        await prisma.areaAlias.create({
          data: { areaId: area.id, alias, normAlias: aliasNorm },
        });
      }
    }

    byName.set(spec.name, area.id);
  }

  return byName;
}

/**
 * Encrypts phone numbers with the same envelope the API uses, so the demo
 * dataset exercises the real decrypt path in the reveal flow.
 */
async function buildPii(): Promise<{
  encrypt: (plain: string) => string;
  blindIndex: (plain: string) => string;
}> {
  const { PiiService } = await import('../src/common/pii.service.js');
  const pii = new PiiService();
  return {
    encrypt: (plain: string) => pii.encrypt(plain),
    blindIndex: (plain: string) => pii.blindIndex(plain),
  };
}

/**
 * Fails the seed before it writes anything if a spec uses a value the contract
 * does not define.
 *
 * This exists because two failures slipped through and cost real time:
 *
 *  - `PricePeriod.ANNUALLY` is not a member of the enum. It evaluated to
 *    `undefined`, so RENT rows were rejected by the Postgres invariant while SALE
 *    rows were silently accepted, and the error surfaced as an unrelated-looking
 *    "Rent listings require a payment period" halfway through the run.
 *  - `'AIR_CONDITIONING'` is not in the closed `AMENITIES` vocabulary. Invalid
 *    codes are dropped rather than rejected, so a listing seeded with one quietly
 *    lost an amenity the poster would otherwise see on the filter.
 *
 * Both are the same class of bug: a typo in a vocabulary meant to be closed,
 * discovered by the database or by nothing at all. Validating up front turns a
 * confusing partial failure into one clear message.
 */
function assertSpecsAreValid(): void {
  const problems: string[] = [];
  const validAmenities = new Set<string>(AMENITIES as readonly string[]);
  const validPeriods = new Set<string>(Object.values(PricePeriod));

  for (const spec of LISTINGS) {
    for (const amenity of spec.amenities ?? []) {
      if (!validAmenities.has(amenity)) {
        problems.push(`"${spec.title}" uses amenity "${amenity}", which is not in the contract vocabulary.`);
      }
    }

    const period = spec.pricePeriod as string | undefined;
    if (!validPeriods.has(period as string)) {
      problems.push(`"${spec.title}" has pricePeriod "${period}", which is not a member of PricePeriod.`);
    } else if (spec.kind === ListingKind.RENT && period === PricePeriod.NONE) {
      problems.push(`"${spec.title}" is RENT but declares pricePeriod NONE.`);
    } else if (spec.kind === ListingKind.SALE && period !== PricePeriod.NONE) {
      problems.push(`"${spec.title}" is SALE but declares pricePeriod ${period}.`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Seed specs are invalid (${problems.length} problem(s)). Fix before seeding:\n  - ` +
        problems.join('\n  - '),
    );
  }
}
/**
 * Creates reviewers, their eligibility records and their reviews.
 *
 * Order matters here and is enforced by the database as much as by this code:
 *
 *  1. The reviewer accounts have to exist before anything references them.
 *  2. The eligibility record (a contact reveal, or a confirmed stay) has to
 *     exist before the review, because the review carries the route it was
 *     written under and the API rejects a review with no matching evidence.
 *     Writing the review first would produce rows that no legal sequence could
 *     create through the product, which is exactly the sort of demo data that
 *     makes a feature look like it works when it does not.
 *  3. Only then the review.
 *
 * Idempotent on `(listingId, authorId)`, which is the unique key the schema
 * already enforces, so a re-seed updates the existing review rather than
 * failing or duplicating.
 */
async function seedReviews(
  areaIds: Map<string, string>,
  pii: { encrypt: (v: string) => string; blindIndex: (v: string) => string },
): Promise<{ reviewers: number; reviews: number; skipped: number }> {
  const reviewerIds: string[] = [];

  for (const spec of REVIEWERS) {
    const user = await prisma.user.upsert({
      where: { email: spec.email },
      update: {
        displayName: spec.displayName,
        phoneIdx: pii.blindIndex(spec.phone),
        verificationTier: spec.tier,
        phoneVerifiedAt: spec.phoneVerified ? new Date() : null,
      },
      create: {
        email: spec.email,
        displayName: spec.displayName,
        phoneEnc: pii.encrypt(spec.phone),
        phoneIdx: pii.blindIndex(spec.phone),
        phoneVerifiedAt: spec.phoneVerified ? new Date() : null,
        verificationTier: spec.tier,
        role: 'USER',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    reviewerIds.push(user.id);
  }

  let written = 0;
  let skipped = 0;

  for (const spec of REVIEWS) {
    // Matched on the title's opening words so the spec stays readable.
    const listing = await prisma.listing.findFirst({
      where: { titleNorm: normName(spec.listing) },
      select: { id: true, posterId: true, status: true },
    });
    const authorId = reviewerIds[spec.reviewer];

    if (!listing || !authorId) {
      console.warn(`  review skip: no listing or reviewer for "${spec.listing}"`);
      skipped += 1;
      continue;
    }

    /*
     * Guard against a reviewer being attached to their own listing. The API
     * forbids this, so honour it here too rather than writing a row that the
     * product could never have produced.
     */
    if (listing.posterId === authorId) {
      console.warn(`  review skip: "${spec.listing}" is owned by its own reviewer`);
      skipped += 1;
      continue;
    }

    // --- eligibility ---
    if (spec.via === 'REVEALED') {
      await prisma.contactReveal.upsert({
        where: { listingId_viewerId: { listingId: listing.id, viewerId: authorId } },
        update: {},
        create: {
          listingId: listing.id,
          viewerId: authorId,
          ownerId: listing.posterId,
          channel: 'PHONE',
        },
      });
    } else {
      const startedAt = new Date(Date.now() - spec.daysAgo * 86_400_000);
      const existing = await prisma.stayRecord.findFirst({
        where: { listingId: listing.id, tenantId: authorId },
        select: { id: true },
      });
      if (!existing) {
        // Both confirmations set, because the API requires both.
        await prisma.stayRecord.create({
          data: {
            listingId: listing.id,
            tenantId: authorId,
            ownerId: listing.posterId,
            startedAt,
            endedAt: new Date(startedAt.getTime() + 365 * 86_400_000),
            ownerConfirmedAt: new Date(),
            tenantConfirmedAt: new Date(),
          },
        });
      }
    }

    const createdAt = new Date(Date.now() - spec.daysAgo * 86_400_000);

    await prisma.review.upsert({
      where: { listingId_authorId: { listingId: listing.id, authorId } },
      update: {
        ratingOverall: spec.overall,
        ratingCommunication: spec.communication,
        ratingAccuracy: spec.accuracy,
        ratingValue: spec.value,
        body: spec.body,
        eligibility: spec.via,
        createdAt,
      },
      create: {
        listingId: listing.id,
        authorId,
        ratingOverall: spec.overall,
        ratingCommunication: spec.communication,
        ratingAccuracy: spec.accuracy,
        ratingValue: spec.value,
        body: spec.body,
        eligibility: spec.via,
        status: 'PUBLISHED',
        createdAt,
      },
    });

    written += 1;
  }

  void areaIds;
  return { reviewers: reviewerIds.length, reviews: written, skipped };
}

/**
 * Repaints the images of listings that already exist.
 *
 * Placeholder art changes as the generator improves, but a normal re-seed skips
 * every existing listing, so the new art would never appear and the fix would
 * look like it did nothing. This mode walks the demo listings, regenerates each
 * asset in place, and rewrites the bytes under the *same* storage key.
 *
 * Same key is required rather than merely convenient. The key is derived from
 * the asset id and is served `immutable`, so minting new keys would leave the
 * old images cached in every browser that had already loaded the page.
 *
 * Run: npm run db:demo -w @naijaproperty/api -- --repaint
 */
async function repaintExistingImages(): Promise<void> {
  const demoPosters = POSTERS.map((p) => p.email);
  const posterIds = await prisma.user
    .findMany({ where: { email: { in: demoPosters } }, select: { id: true } })
    .then((rows) => new Set(rows.map((r) => r.id)));

  const listings = await prisma.listing.findMany({
    where: { posterId: { in: [...posterIds] } },
    select: {
      id: true,
      typeCode: true,
      media: {
        orderBy: { position: 'asc' },
        select: { mediaAsset: { select: { id: true, storageKey: true, kind: true } } },
      },
    },
  });

  let repainted = 0;
  let index = 0;

  for (const listing of listings) {
    for (const link of listing.media) {
      const asset = link.mediaAsset;
      if (asset.kind !== 'IMAGE' || !asset.storageKey) continue;

      const width = 1280;
      const height = link === listing.media[0] ? 854 : 1280;
      const bytes = await generateFacade(index, width, height, listing.typeCode);
      index += 1;

      const stats = await sharp(bytes).stats();
      const dominant = `#${[stats.dominant.r, stats.dominant.g, stats.dominant.b]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')}`;

      // storeDemoImage returns the key it wrote. For R2 assets that equals the
      // key the asset already had; for local files it is the same too, because
      // both are derived from the asset id.
      await storeDemoImage(asset.id, bytes, 'image');

      await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { bytes: BigInt(bytes.byteLength), dominantColor: dominant },
      });

      repainted += 1;
    }
  }

  console.log(`\nrepainted images: ${repainted} across ${listings.length} demo listings`);
}

async function main(): Promise<void> {
  const repaintOnly = process.argv.includes('--repaint');

  console.log(
    repaintOnly ? 'Repainting demo images (dev only)...\n' : 'Seeding demo dataset (dev only)...\n',
  );
  await mkdir(DEMO_DIR, { recursive: true });

  assertSpecsAreValid();

  if (repaintOnly) {
    await repaintExistingImages();
    return;
  }

  const pii = await buildPii();

  // --- posters ---
  const posterIds: string[] = [];
  const agencyIds: Array<string | null> = [];

  for (const spec of POSTERS) {
    const user = await prisma.user.upsert({
      where: { email: spec.email },
      update: {
        displayName: spec.displayName,
        phoneEnc: pii.encrypt(spec.phone),
        phoneIdx: pii.blindIndex(spec.phone),
        phoneVerifiedAt: spec.phoneVerified ? new Date() : null,
        verificationTier: spec.tier,
      },
      create: {
        email: spec.email,
        displayName: spec.displayName,
        phoneEnc: pii.encrypt(spec.phone),
        phoneIdx: pii.blindIndex(spec.phone),
        phoneVerifiedAt: spec.phoneVerified ? new Date() : null,
        verificationTier: spec.tier,
        role: 'USER',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: await hash(DEMO_PASSWORD, { type: 2 }),
      },
      select: { id: true },
    });
    posterIds.push(user.id);

    if (spec.agency) {
      const profile = await prisma.agentProfile.upsert({
        where: { userId: user.id },
        update: {
          agencyName: spec.agency.name,
          licenceVerifiedAt: spec.agency.licenceVerified ? new Date() : null,
        },
        create: {
          userId: user.id,
          agencyName: spec.agency.name,
          licenceVerifiedAt: spec.agency.licenceVerified ? new Date() : null,
        },
        select: { id: true },
      });
      agencyIds.push(profile.id);
    } else {
      agencyIds.push(null);
    }
  }
  console.log(`  posters            : ${posterIds.length}`);

  const areaIds = await upsertAreas();
  console.log(`  areas              : ${areaIds.size} (with aliases)`);

  // --- listings ---
  let created = 0;
  let duplicate = 0;
  let skipped = 0;
  let imageIndex = 0;

  for (const spec of LISTINGS) {
    const areaId = areaIds.get(spec.area);
    const posterId = posterIds[spec.poster];
    if (!areaId || !posterId) {
      console.warn(`  skip "${spec.title}": missing area or poster`);
      skipped += 1;
      continue;
    }

    // Idempotency: titleNorm is unique per poster in spirit, and re-running
    // should not duplicate. Match on poster + title.
    const norm = normName(spec.title);
    const existing = await prisma.listing.findFirst({
      where: { posterId, titleNorm: norm },
      select: { id: true },
    });
    if (existing) {
      duplicate += 1;
      continue;
    }

    const publishedAt = new Date(Date.now() - spec.publishedDaysAgo * 86_400_000);

    const listing = await prisma.listing.create({
      data: {
        kindCode: spec.kind,
        typeCode: spec.type,
        stateCode: (await prisma.area.findUniqueOrThrow({
          where: { id: areaId },
          select: { stateCode: true },
        })).stateCode,
        lgaId: (await prisma.area.findUniqueOrThrow({
          where: { id: areaId },
          select: { lgaId: true },
        })).lgaId,
        areaId,
        exactAddressEnc: pii.encrypt('Plot ' + (created + 12) + ', ' + spec.area + ' (gate code available on viewing)'),
        // Jittered so the map pin does not publish the poster's own coordinates.
        mapLat: null,
        mapLng: null,
        title: spec.title,
        titleNorm: norm,
        description: spec.description,
        price: BigInt(spec.price),
        pricePeriod: spec.pricePeriod,
        priceNegotiable: spec.negotiable ?? false,
        bedrooms: spec.bedrooms ?? null,
        bathrooms: spec.bathrooms ?? null,
        plotSqm: spec.plotSqm ?? null,
        builtSqm: spec.builtSqm ?? null,
        // Deduped: mapping the old shorthand onto the vocabulary can collapse two
    // codes onto one (SECURITY and GATED both became SECURITY_GATED), and a
    // repeated code would render as a duplicated chip.
    amenities: [...new Set(spec.amenities)],
        deedType: spec.deedType ?? DeedType.NONE,
        titleVerifiedAt: spec.titleVerified ? publishedAt : null,
        posterId,
        agencyId: agencyIds[spec.poster],
        status: 'LIVE',
        submittedAt: publishedAt,
        reviewedAt: publishedAt,
        publishedAt,
        expiresAt: new Date(publishedAt.getTime() + 90 * 86_400_000),
        viewCount: spec.views,
        contactClickCount: Math.round(spec.views * 0.04),
      },
      select: { id: true },
    });

    // --- images ---
    for (let p = 0; p < spec.photos; p += 1) {
      const width = 1280;
      const height = p === 0 ? 854 : 1280;
      const fileName = `demo/${listing.id}-${p}.webp`;
      const bytes = await generateFacade(imageIndex, width, height, spec.type);
      imageIndex += 1;

      const stats = await sharp(bytes).stats();
      const dominant =
        `#${[stats.dominant.r, stats.dominant.g, stats.dominant.b]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('')}`;

      // Created UPLOADING first: the storage key is derived from the asset id, so
      // the row has to exist before the bytes can be written.
      const asset = await prisma.mediaAsset.create({
        data: {
          ownerId: posterId,
          kind: 'IMAGE',
          status: 'UPLOADING',
          mime: 'image/webp',
          bytes: BigInt(bytes.byteLength),
          width,
          height,
          dominantColor: dominant,
          moderationStatus: 'CLEAR',
          exifStripped: true,
        },
        select: { id: true },
      });

      const storageKey = await storeDemoImage(asset.id, bytes);

      await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          status: 'READY',
          storageKey,
          compressedBytes: BigInt(bytes.byteLength),
          readyAt: publishedAt,
        },
      });

      await prisma.listingMedia.create({
        data: {
          listingId: listing.id,
          mediaAssetId: asset.id,
          isCover: p === 0,
          position: p,
        },
      });
    }

    // --- video (no real Stream UID; the player is skipped when absent) ---
    if (spec.hasVideo) {
      const posterBytes = await generateVideoPoster(1280, 720);

      const video = await prisma.mediaAsset.create({
        data: {
          ownerId: posterId,
          kind: 'VIDEO',
          status: 'UPLOADING',
          mime: 'video/mp4',
          bytes: BigInt(0),
          width: 1280,
          height: 720,
          durationMs: 96_000,
          dominantColor: '#22303a',
          moderationStatus: 'CLEAR',
        },
        select: { id: true },
      });

      const posterKey = await storeDemoImage(video.id, posterBytes, 'video');
      const publicBase = isR2Configured
        ? (process.env.R2_PUBLIC_URL ?? '').replace(/\/+$/, '')
        : null;

      await prisma.mediaAsset.update({
        where: { id: video.id },
        data: {
          status: 'READY',
          storageKey: posterKey,
          // Absolute URL, because Stream normally hands back an absolute CDN URL
          // for the poster and the detail page renders it as-is.
          posterUrl: publicBase ? `${publicBase}/${posterKey}` : `/demo/${video.id}.webp`,
          readyAt: publishedAt,
        },
      });

      await prisma.listing.update({
        where: { id: listing.id },
        data: { videoAssetId: video.id },
      });
    }

    created += 1;
  }

  console.log(`  listings created   : ${created}`);
  console.log(`  listings duplicate : ${duplicate} (already present)`);
  console.log(`  listings skipped   : ${skipped} (unresolvable area or poster)`);
  if (skipped > 0) {
    throw new Error(
      `${skipped} demo listings could not be placed. Either the LGA is missing from\n` +
        '  seed-data/seed-lgas.ts or the area name has a typo. Fix before trusting the UI.',
    );
  }

  const queued = await seedReviewQueue(areaIds, posterIds, agencyIds, pii);
  console.log(`  review queue       : ${queued} awaiting review`);

  /*
   * Reviews come after the listings, because they are matched onto them by
   * title. Running them first would find nothing to attach to.
   */
  const reviews = await seedReviews(areaIds, pii);
  console.log(
    `  reviewer accounts  : ${reviews.reviewers}\n` +
      `  reviews published  : ${reviews.reviews}` +
      (reviews.skipped > 0 ? ` (${reviews.skipped} skipped)` : ''),
  );
  console.log(
    `\n  demo password      : ${DEMO_PASSWORD}\n` +
      `  demo posters       : ${POSTERS[0].email} … ${POSTERS[POSTERS.length - 1].email}\n` +
      `  placeholder images : ${
        isR2Configured
          ? `R2 bucket ${process.env.R2_BUCKET} (same key layout as production uploads)`
          : `${DEMO_DIR} (no R2 configured — local fallback)`
      }\n` +
      `  note               : ${
        isR2Configured
          ? 'images are served from R2_PUBLIC_URL, so the whole browse surface\n' +
            '                       runs the production storage path'
          : 'set DEMO_MEDIA_BASE_URL=http://localhost:3100 in .env so the API can\n' +
            '                       address these local files'
      }\n`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error('\nDemo seed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
