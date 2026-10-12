import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { hash } from 'argon2';
loadEnv({ path: resolve(process.cwd(), '.env') });
const API = 'http://localhost:4000/api/v1';
const prisma = new PrismaClient();
const email='cors.proof@naijaproperty.local', password='CorsProof-2026';
await prisma.user.upsert({ where:{email}, update:{passwordHash:await hash(password,{type:2}),status:'ACTIVE'},
  create:{email,displayName:'cors-proof',passwordHash:await hash(password,{type:2}),status:'ACTIVE',emailVerifiedAt:new Date()} });
const auth = await (await fetch(`${API}/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})})).json() as any;
const bytes = await readFile('C:/Users/Macbook/AppData/Local/Temp/opencode/posttest/photo-1.jpg');
const p = await (await fetch(`${API}/media/images/presign`,{method:'POST',
  headers:{'content-type':'application/json',authorization:`Bearer ${auth.accessToken}`},
  body:JSON.stringify({fileName:'photo-1.jpg',contentType:'image/jpeg',bytes:bytes.byteLength})})).json() as any;
console.log(JSON.stringify({ assetId:p.assetId, uploadUrl:p.uploadUrl, headers:p.headers, b64: bytes.toString('base64') }));
await prisma.$disconnect();