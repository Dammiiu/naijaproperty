/**
 * One-off: remove em dashes from web app copy and comments.
 *
 * Deliberately a curated mapping rather than a blanket character swap. Replacing
 * every em dash with a hyphen leaves sentences that read like a machine wrote
 * them, which is the thing being fixed. Each pair below is the sentence it should
 * become instead.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'apps/web/src';

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(tsx?|css)$/.test(full)) yield full;
  }
}

/** Exact string pairs. Order matters: longer phrases first. */
const EXACT: Array<[string, string]> = [
  // --- positioning and hero copy
  [
    'Every listing is reviewed by our team before it goes live. Browse freely —\n              sign in only when you want to contact an owner.',
    'Every listing is reviewed by our team before it goes live. Browse freely. Sign\n              in only when you want to contact an owner.',
  ],
  [
    ' Rents in this market are often quoted yearly — try switching the period.',
    ' Rents in this market are often quoted yearly, so try switching the period.',
  ],
  [
    'Naijaproperty — property for rent and sale in Nigeria. Prices are indicative;',
    'Naijaproperty: property for rent and sale in Nigeria. Prices are indicative;',
  ],
  [
    'Naijaproperty — property for rent and sale in Nigeria. Prices are indicative; always verify',
    'Naijaproperty: property for rent and sale in Nigeria. Prices are indicative; always verify',
  ],
  // --- contact panel
  [
    "'The owner has not published a number — use the message button below'",
    "'The owner has not published a number, so use the message button below'",
  ],
  ['Join free</a> — it takes under a minute.', 'Join free</a>. It takes under a minute.'],
  // --- sign in
  [' - no password to forget.', ', with no password to forget.'],
  // --- post form
  [
    "errors.description = `Describe the property in at least 60 characters — you have ${description.trim().length}`;",
    "errors.description = `Describe the property in at least 60 characters. You have written ${description.trim().length}`;",
  ],
  [
    "errors.exactAddress = 'Give the exact address — only signed-in viewers will ever see it';",
    "errors.exactAddress = 'Give the exact address. Only signed-in viewers will ever see it';",
  ],
  [
    'errors.photos = `Upload at least ${MIN_PHOTOS} photos — you have ${ready}`;',
    'errors.photos = `Upload at least ${MIN_PHOTOS} photos. ${ready} ready so far`;',
  ],
  [
    'message: `${body.error.message} Your listing is saved — open your dashboard to submit it again.`,',
    'message: `${body.error.message} Your listing is saved, so open your dashboard to submit it again.`,',
  ],
  [
    'Cannot find your area? Pick the nearest LGA and leave this blank — we will review the',
    'Cannot find your area? Pick the nearest LGA and leave this blank. We will review the',
  ],
  [
    'Locked. Only a signed-in person you reveal it to will ever see this — never a',
    'Locked. Only a signed-in person you reveal it to will ever see this, never a',
  ],
  [
    "?.label} — {kind === 'SALE' ? 'for sale' : 'to rent'}",
    "?.label} for {kind === 'SALE' ? 'sale' : 'rent'}",
  ],
  [
    "needs a CORS rule allowing this site to upload — see docs/cloudflare-setup.md.",
    "needs a CORS rule allowing this site to upload. See docs/cloudflare-setup.md.",
  ],
  // --- admin
  ['The API may be restarting — reload in a moment.', 'The API may be restarting, so reload in a moment.'],
  [
    'in this market — reject rather than request changes, because a poster asked to',
    'in this market. Reject rather than request changes, because a poster asked to',
  ],
  ['Append-only at the database level — a', 'Append-only at the database level. A'],
  ['Moderator — read only', 'Moderator, read only'],
  ['`Make ${name} selectable — currently ${listingCount} listing(s)`', '`Make ${name} selectable. Currently ${listingCount} listing(s)`'],
  ['Hide ${name} from the post form and search', 'Hide ${name} from the post form and search'],
  // --- dashboard
  [
    'reviewed by our team before it goes live —\n              usually within a few hours.',
    'reviewed by our team before it goes live, usually\n              within a few hours.',
  ],
  // --- kind toggle
  ["{selected ? ' (current)' : ''} — {k.hint}", "{selected ? ' (current)' : ''} {k.hint}"],
  // --- layout metadata
  ['`${siteName} — Property for Rent and Sale in Nigeria`', '`${siteName} | Property for Rent and Sale in Nigeria`'],
];

/**
 * Fallback for comments and any copy not covered above.
 *
 * " - " is the honest substitute in prose; a bare em dash at the end of a clause
 * becomes a comma, which is almost always what was meant.
 */
const SPACED = ' — ';
const SPACED_TO = ', ';
const BARE_TRAILING = /—\s*$/;

let changedFiles = 0;
let replacements = 0;

for (const file of walk(ROOT)) {
  const before = readFileSync(file, 'utf8');
  let after = before;

  for (const [from, to] of EXACT) {
    if (after.includes(from)) {
      replacements += after.split(from).length - 1;
      after = after.split(from).join(to);
    }
  }

  if (after.includes(SPACED)) {
    replacements += after.split(SPACED).length - 1;
    after = after.split(SPACED).join(SPACED_TO);
  }

  // Any em dash still standing is an unspaced one, which is always a sentence
  // that ran on without punctuation.
  after = after.replace(/—\s*([a-z])/g, ', $1');
  after = after.replace(BARE_TRAILING, '.');

  if (after !== before) {
    writeFileSync(file, after, 'utf8');
    changedFiles += 1;
  }
}

const remaining = [...walk(ROOT)].filter((f) => readFileSync(f, 'utf8').includes('—'));
console.log(`changed ${changedFiles} file(s), ${replacements} curated replacement(s)`);
console.log(`files still containing an em dash: ${remaining.length}`);
for (const f of remaining) console.log('  ' + f);