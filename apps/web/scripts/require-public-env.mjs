/**
 * Fails the image build when a NEXT_PUBLIC_* value is missing.
 *
 * Why this exists
 * ---------------
 * Next.js inlines `NEXT_PUBLIC_*` into the client bundle at BUILD time. Setting
 * them only when the container runs has no effect on the JavaScript a browser
 * downloads.
 *
 * The app itself treats a blank value as absent and falls back to localhost.
 * That is the correct behaviour for `npm run build` on a laptop and the wrong
 * behaviour for a deploy image: the site renders, looks fine, and every API call
 * goes to 127.0.0.1, so nothing fails until a user clicks something.
 *
 * A silent wrong deploy is far more expensive than a failed build, so a deploy
 * image with these unset is treated as a mistake and stops here with the exact
 * flags to add.
 *
 * Run by apps/web/Dockerfile, not by `next build` directly, so local builds stay
 * convenient.
 */

const REQUIRED = ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_WEB_URL'];

const missing = REQUIRED.filter((key) => !(process.env[key] ?? '').trim());

if (missing.length > 0) {
  console.error(`\nMissing required build arguments: ${missing.join(', ')}\n`);
  console.error('These are inlined into the browser bundle at build time, so they');
  console.error('cannot be supplied when the container runs. Pass them to docker build:\n');
  console.error('  docker build -f apps/web/Dockerfile \\');
  console.error('    --build-arg NEXT_PUBLIC_API_URL=https://api.naijaproperty.ng \\');
  console.error('    --build-arg NEXT_PUBLIC_WEB_URL=https://naijaproperty.ng .\n');
  process.exit(1);
}

console.log(
  `build args ok: ${REQUIRED.map((k) => `${k}=${process.env[k]}`).join('  ')}`,
);
