/**
 * Messaging verification.
 *
 * Covers the three properties that are easy to get wrong and expensive to get
 * wrong, because each one silently misleads a real person:
 *
 *   1. A pending message must not reach the recipient. If it does, the first thing
 *      a poster sees is fraud, and they leave the platform.
 *   2. An unread count must be right. Under-counting hides a reply; over-counting
 *      makes a badge that never clears.
 *   3. A conversation must be unreadable to anyone who is not in it. Conversation
 *      ids appear in reveal responses, so they are not secret.
 *
 * Run with the API up and NJP_E2E=1: `npm run verify:messages -w @naijaproperty/api`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

loadEnv({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'),
});

const API = process.env.API_URL ?? 'http://localhost:4000';
const BASE = `${API}/api/v1`;
const prisma = new PrismaClient();

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`);
  }
}

type Headers = Record<string, string>;

async function login(email: string): Promise<{ headers: Headers; userId: string }> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'DemoPass!2026njp' }),
  });
  const body = (await res.json()) as { accessToken?: string; user?: { id: string } };
  if (!body.accessToken) throw new Error(`login failed for ${email}`);
  return {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${body.accessToken}` },
    userId: body.user!.id,
  };
}

async function main() {
  const alice = await login('demo.ada@listers.ng');
  const bob = await login('demo.tunde@listers.ng');

  // Find a live listing owned by someone other than Alice, preferring Bob's so the
  // second party is a known demo account with the same password.
  const candidates = await prisma.listing.findMany({
    where: { status: 'LIVE', posterId: { not: alice.userId } },
    select: { id: true, posterId: true, title: true },
  });
  const chosen = candidates.find((c) => c.posterId === bob.userId) ?? candidates[0];
  if (!chosen) throw new Error('need at least one live listing not owned by Alice');

  const ownerEmail = (
    await prisma.user.findUnique({ where: { id: chosen.posterId }, select: { email: true } })
  )!.email;
  const owner = await login(ownerEmail);

  // --- Auth ---------------------------------------------------------------
  check(
    'an anonymous caller cannot list conversations',
    (await fetch(`${BASE}/conversations`)).status === 401,
  );

  const opened = (await (
    await fetch(`${BASE}/conversations`, {
      method: 'POST',
      headers: alice.headers,
      body: JSON.stringify({ listingId: chosen.id }),
    })
  ).json()) as { id?: string };
  check('a signed-in viewer can open a conversation', Boolean(opened.id));
  const cid = opened.id!;

  const reopened = (await (
    await fetch(`${BASE}/conversations`, {
      method: 'POST',
      headers: alice.headers,
      body: JSON.stringify({ listingId: chosen.id }),
    })
  ).json()) as { id?: string };
  check('opening the same listing twice returns the same thread', reopened.id === cid);

  check(
    'a poster cannot open a conversation about their own listing',
    (await (
      await fetch(`${BASE}/conversations`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({ listingId: chosen.id }),
      })
    ).status) === 403,
  );

  // --- Sending ------------------------------------------------------------
  const clientMessageId = `cmverify${Date.now().toString(36)}`;
  const first = (await (
    await fetch(`${BASE}/conversations/${cid}/messages`, {
      method: 'POST',
      headers: alice.headers,
      body: JSON.stringify({
        body: 'Is this still available? I can view on Saturday morning.',
        clientMessageId,
      }),
    })
  ).json()) as { id: string; moderationStatus: string };

  check('a new message starts pending moderation', first.moderationStatus === 'PENDING');

  const replay = (await (
    await fetch(`${BASE}/conversations/${cid}/messages`, {
      method: 'POST',
      headers: alice.headers,
      body: JSON.stringify({
        body: 'Is this still available? I can view on Saturday morning.',
        clientMessageId,
      }),
    })
  ).json()) as { id: string };
  check('replaying an idempotency key does not duplicate the message', replay.id === first.id);

  check(
    'a blank message is rejected',
    (await (
      await fetch(`${BASE}/conversations/${cid}/messages`, {
        method: 'POST',
        headers: alice.headers,
        body: JSON.stringify({ body: '   ', clientMessageId: `cmblank${Date.now().toString(36)}` }),
      })
    ).status) === 400,
  );

  check(
    'a message into a conversation that does not exist is a 404',
    (await (
      await fetch(`${BASE}/conversations/cmzzzzzzzzzzzzzzzzzzzzzzzzz/messages`, {
        method: 'POST',
        headers: alice.headers,
        body: JSON.stringify({ body: 'hi', clientMessageId: `cmghost${Date.now().toString(36)}` }),
      })
    ).status) === 404,
  );

  // --- Moderation isolation ----------------------------------------------
  const ownerWhilePending = (await (
    await fetch(`${BASE}/conversations/${cid}`, { headers: owner.headers })
  ).json()) as { messages: unknown[] };

  check(
    'the recipient cannot see a message that has not passed moderation',
    ownerWhilePending.messages.length === 0,
    `saw ${ownerWhilePending.messages.length}`,
  );

  const senderStillSees = (await (
    await fetch(`${BASE}/conversations/${cid}`, { headers: alice.headers })
  ).json()) as { messages: Array<{ body: string; moderationStatus?: string }> };

  check(
    'the sender still sees their own pending message',
    senderStillSees.messages.some((m) => m.body.includes('Saturday morning')),
  );

  await prisma.message.update({ where: { id: first.id }, data: { moderationStatus: 'CLEAR' } });

  const ownerAfterClear = (await (
    await fetch(`${BASE}/conversations/${cid}`, { headers: owner.headers })
  ).json()) as { messages: unknown[] };
  check('a cleared message reaches the recipient', ownerAfterClear.messages.length === 1);

  // --- Unread -------------------------------------------------------------
  /*
   * This is the assertion that catches the bug worth catching. An earlier version
   * used the thread's last activity as the cutoff for a thread that had never
   * been opened. Since the newest message is what *sets* last activity, that
   * message was never strictly after the cutoff, so the one reply a person is
   * waiting for was the one thing that never appeared as unread.
   */
  const ownerInbox = (await (
    await fetch(`${BASE}/conversations`, { headers: owner.headers })
  ).json()) as { items: Array<{ id: string; unread: number; lastMessagePreview: string | null }> };
  const ownerThread = ownerInbox.items.find((c) => c.id === cid);

  check(
    'a never-opened thread reports the recipient message as unread',
    ownerThread?.unread === 1,
    `unread=${ownerThread?.unread}`,
  );
  check(
    'the thread preview carries the message text',
    Boolean(ownerThread?.lastMessagePreview?.includes('Saturday morning')),
  );

  await fetch(`${BASE}/conversations/${cid}/read`, {
    method: 'POST',
    headers: owner.headers,
    // The endpoint takes no parameters, but an empty body with a JSON content
    // type is a 400 from Fastify, so the contract is satisfied explicitly.
    body: '{}',
  });

  const ownerAfterRead = (await (
    await fetch(`${BASE}/conversations`, { headers: owner.headers })
  ).json()) as { items: Array<{ id: string; unread: number }> };
  check(
    'marking read clears the unread count',
    ownerAfterRead.items.find((c) => c.id === cid)?.unread === 0,
  );

  // A reply after the read must count again.
  const replyId = `cmreply${Date.now().toString(36)}`;
  await fetch(`${BASE}/conversations/${cid}/messages`, {
    method: 'POST',
    headers: owner.headers,
    body: JSON.stringify({ body: 'Yes, Saturday works. Come by 11am.', clientMessageId: replyId }),
  });
  await prisma.message.update({
    where: { conversationId_clientMessageId: { conversationId: cid, clientMessageId: replyId } },
    data: { moderationStatus: 'CLEAR' },
  });

  const aliceInbox = (await (
    await fetch(`${BASE}/conversations`, { headers: alice.headers })
  ).json()) as { items: Array<{ id: string; unread: number }> };
  check(
    'a reply after the read watermark counts as unread again',
    aliceInbox.items.find((c) => c.id === cid)?.unread === 1,
    `unread=${aliceInbox.items.find((c) => c.id === cid)?.unread}`,
  );

  // --- Isolation ----------------------------------------------------------
  const stranger = await login('demo.chidi@listers.ng');
  check(
    'someone outside the thread gets a 404, not the messages',
    (await fetch(`${BASE}/conversations/${cid}`, { headers: stranger.headers })).status === 404,
  );

  check(
    'someone outside the thread cannot post into it',
    (await (
      await fetch(`${BASE}/conversations/${cid}/messages`, {
        method: 'POST',
        headers: stranger.headers,
        body: JSON.stringify({
          body: 'injecting',
          clientMessageId: `cminject${Date.now().toString(36)}`,
        }),
      })
    ).status) === 404,
  );

  check(
    'someone outside the thread cannot mark it read',
    (await fetch(`${BASE}/conversations/${cid}/read`, {
      method: 'POST',
      headers: stranger.headers,
      body: '{}',
    })).status === 404,
  );

  const strangerInbox = (await (
    await fetch(`${BASE}/conversations`, { headers: stranger.headers })
  ).json()) as { items: unknown[] };
  check(
    "the stranger's inbox does not contain the thread",
    !strangerInbox.items.some((c) => (c as { id: string }).id === cid),
  );

  // --- Confidentiality ----------------------------------------------------
  const raw = JSON.stringify(await (await fetch(`${BASE}/conversations/${cid}`, { headers: alice.headers })).json());
  check('a thread payload leaks no encrypted address envelope', !raw.includes('v1.'));

  // --- Cleanup ------------------------------------------------------------
  await prisma.conversation.delete({ where: { id: cid } }).catch(() => undefined);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/**
 * Removes this harness's own fixtures. See scripts/lib/cleanup-fixtures.ts for
 * why this is not optional.
 */
async function cleanupFixtures(): Promise<void> {
  const { cleanupFixtures: shared } = await import('./lib/cleanup-fixtures.js');
  await shared(prisma);
}

main()
  .then(async () => {
    await cleanupFixtures();
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await cleanupFixtures().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  });