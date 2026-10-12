/**
 * One-off repair: re-encrypt exactAddressEnc rows written by the old
 * verify-phase2 fixture as `sealed::...` plaintext.
 *
 * The plaintext is recoverable because it was never encrypted in the first
 * place, so this re-seals it with the real envelope rather than discarding the
 * addresses.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
loadEnv({ path: resolve(process.cwd(), '.env') });
import { PiiService } from '../src/common/pii.service.js';

const prisma = new PrismaClient();
const pii = new PiiService();

async function main() {
  const rows = await prisma.listing.findMany({
    where: { exactAddressEnc: { startsWith: 'sealed::' } },
    select: { id: true, title: true, exactAddressEnc: true },
  });
  console.log('rows to repair:', rows.length);
  if (rows.length === 0) return;

  let repaired = 0;
  for (const r of rows) {
    const plain = (r.exactAddressEnc as string).replace(/^sealed::/, '');
    await prisma.listing.update({
      where: { id: r.id },
      data: { exactAddressEnc: pii.encrypt(plain) },
    });
    repaired += 1;
  }
  console.log('repaired:', repaired);

  // Prove every row now round-trips.
  const after = await prisma.listing.findMany({ select: { id:true, title:true, exactAddressEnc:true } });
  let bad = 0;
  for (const l of after) {
    if (!l.exactAddressEnc) { bad++; continue; }
    try { pii.decrypt(l.exactAddressEnc); } catch { bad++; console.log('  still unreadable:', l.title.slice(0,40)); }
  }
  console.log(`all ${after.length} listings decrypt cleanly: ${bad === 0 ? 'yes' : 'NO, ' + bad + ' bad'}`);
  console.log('remaining plaintext rows:', await prisma.listing.count({ where: { exactAddressEnc: { startsWith: 'sealed::' } } }));
  await prisma.$disconnect();
}
main();