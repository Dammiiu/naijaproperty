/**
 * Google OAuth CSRF regression check.
 *
 * The flow previously read `state` off the query string and the callback never
 * compared it at all, despite a comment claiming it was verified. That is login
 * CSRF: an attacker completes the flow with their own account and induces a
 * victim to finish the callback, leaving the victim signed in as the attacker.
 *
 * Needs a throwaway API with dummy Google credentials on port 4001, so no real
 * Google account is involved and no authorization code is ever redeemed:
 *
 *   # terminal 1
 *   $env:API_PORT=4001; $env:API_URL=http://localhost:4001
 *   $env:GOOGLE_CLIENT_ID=test; $env:GOOGLE_CLIENT_SECRET=test
 *   npm run start -w @naijaproperty/api
 *
 *   # terminal 2
 *   npm run verify:google -w @naijaproperty/api
 *
 * Dummy credentials are deliberate: every check below happens before the token
 * exchange, or asserts that the exchange was reached and refused. That is what
 * makes it safe to run with no real Google project connected.
 */
const BASE = 'http://localhost:4001';
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  PASS ', name)) : (fail++, console.log('  FAIL ', name)); };

const start = await fetch(`${BASE}/api/v1/auth/google/start`, { redirect: 'manual' });
const location = start.headers.get('location') ?? '';
const setCookie = start.headers.get('set-cookie') ?? '';

ok('start redirects to Google', start.status === 302 && location.includes('accounts.google.com'));

const stateInUrl = new URL(location).searchParams.get('state') ?? '';
const cookieMatch = /njp_oauth_state=([^;]+)/.exec(setCookie);
const cookieState = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';

ok('a nonce is issued', stateInUrl.length > 20 && cookieState.length > 20);
ok('the nonce matches what is sent to Google', stateInUrl === cookieState);
ok('the nonce cookie is httpOnly', /HttpOnly/i.test(setCookie));
ok('the nonce cookie is SameSite=Lax so it survives the cross-site callback', /SameSite=Lax/i.test(setCookie));
ok('the nonce cookie is short lived', /Max-Age=600/i.test(setCookie));
ok('the nonce cookie is scoped to the auth routes', /Path=\/api\/v1\/auth/i.test(setCookie));

const cookieHeader = `njp_oauth_state=${encodeURIComponent(cookieState)}`;

// The attack: a callback carrying an authorization code but no nonce at all.
const noState = await fetch(`${BASE}/api/v1/auth/google/callback?code=fake`, { redirect: 'manual' });
const noStateLoc = noState.headers.get('location') ?? '';
ok('a callback with no state is rejected', noStateLoc.includes('error=invalid_state'));
ok('a rejected callback clears the nonce cookie', /njp_oauth_state=;|njp_oauth_state=""/.test(noState.headers.get('set-cookie') ?? ''));

// And one where the attacker supplies their own nonce.
const forged = await fetch(
  `${BASE}/api/v1/auth/google/callback?code=fake&state=attacker-supplied-nonce`,
  { redirect: 'manual' },
);
ok('a callback with a forged state is rejected', (forged.headers.get('location') ?? '').includes('error=invalid_state'));

// The happy path reaches the token exchange, which fails because the code is
// fake. That is the correct outcome: CSRF passed, Google refused the code.
const correct = await fetch(
  `${BASE}/api/v1/auth/google/callback?code=fake&state=${encodeURIComponent(cookieState)}`,
  { redirect: 'manual', headers: { cookie: cookieHeader } },
);
const correctLoc = correct.headers.get('location') ?? '';
ok('a correct nonce passes the CSRF gate and reaches the exchange', correctLoc.includes('error=oauth_failed') && !correctLoc.includes('invalid_state'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
