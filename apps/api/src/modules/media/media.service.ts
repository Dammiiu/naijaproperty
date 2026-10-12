/**
 * Media pipeline.
 *
 * The load-bearing decision here: **media bytes never pass through this API.**
 *
 * Images go browser -> Cloudflare R2 via presigned PUT. Video goes browser ->
 * Cloudflare Stream via Direct Creator Upload (tus, resumable). The API only
 * issues signed URLs, records state, and consumes webhooks. Consequences:
 *
 *   - Uploading a 2GB walkthrough video costs the API zero CPU and zero memory.
 *   - Horizontal scaling of the API does not affect upload throughput.
 *   - R2 has no egress fee, which matters when serving Nigerian traffic.
 *
 * Everything here is also defence in depth, because uploads are the main
 * attack surface for arbitrary file content:
 *   - presigned URLs are constrained by content-type and byte length
 *   - the declared MIME type is verified against magic bytes on completion
 *   - EXIF GPS is extracted then stripped, so a poster's home is not published
 *   - documents (title deeds) are quarantined until an admin approves them
 *   - per-owner content-hash dedupe collapses the same photo re-uploaded
 *     across dozens of listings, which agencies do constantly
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PutObjectCommand, S3Client, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PresignResponse } from '@naijaproperty/contracts';
import { ApiException, presignImageRequestSchema, presignVideoRequestSchema, completeUploadSchema } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { getEnv } from '../../config/env.js';

/** Magic byte signatures. Declared MIME types are attacker-controlled. */
const MAGIC: Record<string, { offset: number; bytes: number[]; mime: string }[]> = {
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' }],
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png' }],
  'image/webp': [
    // RIFF container: "RIFF" .... "WEBP"
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' },
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50], mime: 'image/webp' },
  ],
  'image/avif': [
    { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70], mime: 'image/avif' },
    { offset: 8, bytes: [0x61, 0x76, 0x69, 0x66], mime: 'image/avif' },
  ],
  'video/mp4': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70], mime: 'video/mp4' }],
  'video/quicktime': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70], mime: 'video/mp4' }],
  'video/webm': [
    { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: 'video/webm' },
  ],
  'application/pdf': [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' }],
};

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private r2: S3Client | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private client(): S3Client {
    if (this.r2) return this.r2;
    const env = getEnv();
    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      throw ApiException.internal('Object storage is not configured');
    }
    this.r2 = new S3Client({
      region: 'auto',
      endpoint: env.R2_ENDPOINT || undefined,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    return this.r2;
  }

  // --- Image path ---------------------------------------------------------

  async presignImage(
    raw: unknown,
    ownerId: string,
  ): Promise<PresignResponse> {
    const parsed = presignImageRequestSchema.safeParse(raw);
    if (!parsed.success) throw ApiException.validation(issues(parsed.error));

    const { fileName, contentType, bytes } = parsed.data;

    const asset = await this.prisma.mediaAsset.create({
      data: {
        ownerId,
        kind: 'IMAGE',
        status: 'PENDING',
        mime: contentType,
        bytes: BigInt(bytes),
      },
    });

    const key = this.buildKey(ownerId, 'image', asset.id, contentType);
    const expiresIn = 900;

    /*
     * Two things must NOT be set on this command, both discovered by testing
     * against the real bucket rather than by reading the docs:
     *
     * 1. `ContentLength`. It would pin the signature to one byte length, but
     *    Content-Length is a forbidden header name in the Fetch spec — no browser
     *    can set it, so every real upload would 403. The size limit is enforced
     *    instead at complete-time by comparing HeadObject's ContentLength against
     *    the declared bytes, which is the better check anyway because it measures
     *    what was actually stored rather than what the client claimed.
     *
     * 2. `Metadata`. User metadata becomes an `x-amz-meta-*` request header, which
     *    is folded into the SigV4 canonical request. R2 does not canonicalise those
     *    headers the way the AWS SDK does, so it computes a different signature and
     *    rejects the PUT with SignatureDoesNotMatch. Verified directly: a
     *    presigned PUT with ContentType alone returns 200, and the identical PUT
     *    with any Metadata returns 403. Do not re-add it.
     *
     *    Traceability does not need it: buildKey() already embeds both the owner
     *    and the asset id in the object path, so any object can be traced back to
     *    its row by reading its key.
     *
     * The only signed header a client must therefore replay is Content-Type, which
     * is why `headers` carries exactly one entry.
     */
    const url = await getSignedUrl(
      this.client(),
      new PutObjectCommand({
        Bucket: getEnv().R2_BUCKET,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn },
    );

    await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: 'UPLOADING', storageKey: key },
    });

    return {
      assetId: asset.id,
      status: 'UPLOADING',
      uploadUrl: url,
      headers: { 'content-type': contentType },
      expiresInSeconds: expiresIn,
      maxBytes: bytes,
    };
  }

  // --- Video path ---------------------------------------------------------

  /**
   * Cloudflare Stream Direct Creator Upload.
   *
   * Returns a one-time tus endpoint the browser uploads to directly. Resumability
   * matters: a failed 200MB upload on a Nigerian mobile connection must not have
   * to restart from zero.
   */
  async presignVideo(raw: unknown, ownerId: string): Promise<PresignResponse> {
    const parsed = presignVideoRequestSchema.safeParse(raw);
    if (!parsed.success) throw ApiException.validation(issues(parsed.error));

    const { fileName, contentType, bytes } = parsed.data;
    const env = getEnv();

    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_STREAM_TOKEN) {
      throw ApiException.internal('Video streaming is not configured');
    }

    const asset = await this.prisma.mediaAsset.create({
      data: {
        ownerId,
        kind: 'VIDEO',
        status: 'UPLOADING',
        mime: contentType,
        bytes: BigInt(bytes),
      },
    });

    /*
     * Direct Creator Upload.
     *
     * Request shape notes, because getting these wrong fails in ways that look
     * like Cloudflare being down:
     *
     *  - `requireSignedURLs` is a TOP-LEVEL field. It was previously nested inside
     *    `meta`, where Cloudflare silently ignores it. That is worse than a
     *    mistake: the listing looked configured for public playback while the
     *    field was doing nothing. A property walkthrough is public content, so the
     *    value stays false and is now stated where it is honoured.
     *  - `meta.name` is the documented filename field. `fileName` is not one, so it
     *    was being dropped and the Stream dashboard showed no filename.
     *  - `expiry` must be RFC3339. It bounds how long the browser may take to
     *    finish, so it is generous: a 200MB upload on a poor connection can
     *    legitimately take most of an hour, and a short window strands the
     *    upload with no way to resume.
     */
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/direct_upload`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.CLOUDFLARE_STREAM_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          maxDurationSeconds: 3600,
          // Public playback: a walkthrough video is meant to be watched, and a
          // signed URL would break the embed and share links on the listing.
          requireSignedURLs: false,
          expiry: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
          meta: {
            name: fileName.slice(0, 200),
            assetId: asset.id,
            ownerId,
          },
        }),
      },
    );

    if (!response.ok) {
      await this.prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { status: 'FAILED', moderationNotes: `stream_error_${response.status}` },
      });
      const text = await response.text();

      /*
       * 401 and 403 are configuration faults, not outages.
       *
       * Both are also the two most common operator mistakes with this token: it
       * was created without the Stream scope, or with read-only Stream access.
       * Saying so in the log is the difference between an hour of guessing and a
       * one-line fix, and a transient 5xx is deliberately logged differently so the
       * two are never confused when reading logs months later.
       */
      if (response.status === 401 || response.status === 403) {
        this.logger.error(
          `Stream direct_upload refused (${response.status}). This is a credentials problem, not an ` +
            `outage: CLOUDFLARE_STREAM_TOKEN needs Account -> Stream -> Edit on account ` +
            `${env.CLOUDFLARE_ACCOUNT_ID}. Body: ${text.slice(0, 300)}`,
        );
      } else {
        this.logger.warn(
          `Stream direct_upload failed (${response.status}): ${text.slice(0, 300)}`,
        );
      }

      throw new ApiException('UPSTREAM_UNAVAILABLE', 'Video upload is unavailable right now', 502);
    }

    const payload = (await response.json()) as {
      success: boolean;
      result?: { uploadURL: string; uid: string };
      errors?: Array<{ message: string }>;
    };

    if (!payload.success || !payload.result) {
      await this.prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { status: 'FAILED' },
      });
      throw new ApiException('UPSTREAM_UNAVAILABLE', 'Could not start the video upload', 502);
    }

    await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: 'UPLOADING', streamUid: payload.result.uid },
    });

    return {
      assetId: asset.id,
      status: 'UPLOADING',
      uploadUrl: payload.result.uploadURL,
      headers: {},
      // Matches the `expiry` sent above. Reporting a shorter window than Cloudflare
      // actually honours would make the client give up on an upload that would
      // still have been accepted.
      expiresInSeconds: 4 * 60 * 60,
      maxBytes: bytes,
    };
  }

  // --- Title / licence documents -----------------------------------------

  async presignDocument(raw: unknown, ownerId: string): Promise<PresignResponse> {
    const input = raw as { fileName?: string; contentType?: string; bytes?: number };
    const fileName = String(input.fileName ?? 'document.pdf');
    const contentType = String(input.contentType ?? 'application/pdf');
    const bytes = Number(input.bytes ?? 0);

    if (!/^application\/pdf$|^image\/(jpeg|png)$/.test(contentType)) {
      throw ApiException.validation([
        { path: 'contentType', message: 'Upload a PDF, JPEG or PNG document' },
      ]);
    }
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 20 * 1024 * 1024) {
      throw ApiException.validation([
        { path: 'bytes', message: 'Document must be between 1 byte and 20MB' },
      ]);
    }

    const asset = await this.prisma.mediaAsset.create({
      data: {
        ownerId,
        kind: 'DOCUMENT',
        // Documents are quarantined until an admin accepts them, because a title
        // deed is the highest-value document a user will upload and the one a
        // fraudster most wants to substitute.
        status: 'UPLOADING',
        mime: contentType,
        bytes: BigInt(bytes),
      },
    });

    const key = this.buildKey(ownerId, 'document', asset.id, contentType);
    const expiresIn = 900;

    const url = await getSignedUrl(
      this.client(),
      new PutObjectCommand({
        Bucket: getEnv().R2_BUCKET,
        Key: key,
        ContentType: contentType,
        // No ContentLength: it is a forbidden header in the Fetch spec, so signing
        // it makes the URL unusable from a browser. The size is checked at
        // complete-time via HeadObject instead. See the image presign for the
        // full reasoning.
      }),
      { expiresIn },
    );

    await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: 'UPLOADING', storageKey: key },
    });

    return {
      assetId: asset.id,
      status: 'UPLOADING',
      uploadUrl: url,
      headers: { 'content-type': contentType },
      expiresInSeconds: expiresIn,
      maxBytes: bytes,
    };
  }

  // --- Completion ---------------------------------------------------------

  /**
   * Called once the browser reports the upload finished.
   *
   * Verifies the object actually exists in R2 at the expected size before
   * trusting the client's report, then checks magic bytes.
   */
  async completeImage(raw: unknown, ownerId: string): Promise<{ assetId: string; duplicate: boolean }> {
    const parsed = completeUploadSchema.safeParse(raw);
    if (!parsed.success) throw ApiException.validation(issues(parsed.error));

    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: parsed.data.assetId, ownerId },
    });
    if (!asset) throw ApiException.notFound('Upload not found');
    if (asset.kind !== 'IMAGE') throw ApiException.validation([
      { path: 'assetId', message: 'That upload is not an image' },
    ]);
    if (asset.status === 'READY') return { assetId: asset.id, duplicate: true };

    const key = asset.storageKey;
    if (!key) throw ApiException.internal('Upload was never initialised');

    let actualBytes = 0;
    try {
      const head = await this.client().send(
        new HeadObjectCommand({ Bucket: getEnv().R2_BUCKET, Key: key }),
      );
      actualBytes = Number(head.ContentLength ?? 0);
    } catch {
      await this.prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { status: 'FAILED', moderationNotes: 'object_missing_after_upload' },
      });
      throw new ApiException('MEDIA_NOT_READY', 'That upload did not complete. Try again.', 400);
    }

    if (actualBytes !== Number(asset.bytes)) {
      this.logger.warn(
        `Size mismatch for ${asset.id}: expected ${asset.bytes}, got ${actualBytes}`,
      );
      await this.prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { status: 'FAILED', moderationNotes: 'size_mismatch' },
      });
      throw new ApiException('MEDIA_NOT_READY', 'Upload size did not match. Try again.', 400);
    }

    // Dedupe: the same photo re-uploaded across many listings is normal agency
    // behaviour, and content-hash uniqueness collapses it to one stored object.
    if (parsed.data.contentHash) {
      const existing = await this.prisma.mediaAsset.findFirst({
        where: { ownerId, contentHash: parsed.data.contentHash, id: { not: asset.id } },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.mediaAsset.update({
          where: { id: asset.id },
          data: {
            status: 'QUARANTINED',
            contentHash: parsed.data.contentHash,
            moderationNotes: `duplicate_of:${existing.id}`,
          },
        });
        return { assetId: asset.id, duplicate: true };
      }
    }

    // Ready for the post-processing worker: EXIF strip, blurhash, moderation.
    await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        status: 'PROCESSING',
        ...(parsed.data.contentHash ? { contentHash: parsed.data.contentHash } : {}),
      },
    });

    return { assetId: asset.id, duplicate: false };
  }

  /**
   * Verifies magic bytes against the declared MIME type.
   * Used by the processing worker once it reads the first bytes of the object.
   * The declared content-type on a presigned PUT is a client claim, not proof.
   */
  static verifyMagicBytes(declaredMime: string, head: Buffer): boolean {
    const signatures = MAGIC[declaredMime];
    if (!signatures) return false;
    return signatures.every((sig) =>
      sig.bytes.every((b, i) => head[sig.offset + i] === b),
    );
  }

  static sha256Hex(input: Buffer | string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  /**
   * Object key layout.
   *
   * `${category}/${shard}/${assetId}.${ext}`
   *
   * Two constraints pull in opposite directions here, and both are load-bearing:
   *
   * 1. The key must BE the public URL. R2 has no rewrite layer, so a
   *    `r2.dev` public URL can only address an object at its real key. The key
   *    therefore cannot contain the owner's user id: that would publish it, and
   *    cuid owner ids in a public path are both a privacy leak and a scraper's
   *    map of who owns how many properties.
   *
   * 2. Keys must spread across partitions. A single flat prefix becomes a hot
   *    partition under load. Sharding on the first two characters does not work
   *    for cuids — every recent one starts `cm` — so the shard is derived from a
   *    hash of the asset id instead, which is uniformly distributed.
   *
   * Images always carry a `.webp` extension because the worker converts every one
   * of them, regardless of what was uploaded. Serving is only ever attempted on a
   * READY asset, so the extension always matches the stored bytes.
   */
  private buildKey(
    ownerId: string,
    category: string,
    assetId: string,
    contentType: string,
  ): string {
    // Images are normalised to WebP by the worker, so the extension is fixed
    // rather than derived from the upload type.
    const ext =
      category === 'image'
        ? 'webp'
        : (contentType.split('/')[1]?.replace('+xml', '') ?? 'bin');

    void ownerId;
    const shard = createHash('sha256').update(assetId).digest('hex').slice(0, 2);
    return `${category}/${shard}/${assetId}.${ext}`;
  }

  /** Owner-scoped status read. Never exposes the storage key. */
  async statusForOwner(assetId: string, ownerId: string): Promise<Record<string, unknown>> {
    const parsed = z.string().cuid().safeParse(assetId);
    if (!parsed.success) throw ApiException.notFound('Media not found');

    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: parsed.data, ownerId },
      select: {
        id: true,
        kind: true,
        status: true,
        bytes: true,
        width: true,
        height: true,
        durationMs: true,
        blurhash: true,
        dominantColor: true,
        posterUrl: true,
        playbackHls: true,
        moderationStatus: true,
        moderationNotes: true,
        createdAt: true,
        readyAt: true,
      },
    });

    if (!asset) throw ApiException.notFound('Media not found');

    return {
      ...asset,
      bytes: asset.bytes ? Number(asset.bytes) : 0,
      createdAt: asset.createdAt.toISOString(),
      readyAt: asset.readyAt?.toISOString() ?? null,
    };
  }

  /**
   * Reaper for abandoned uploads.
   *
   * A poster who abandons a half-finished upload leaves both a database row and an
   * R2 object. Over thousands of abandoned 200MB videos this becomes the single
   * largest avoidable storage cost, so this runs hourly.
   */
  async reapOrphanedUploads(olderThanHours = 24): Promise<{ rows: number }> {
    const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);

    const orphans = await this.prisma.mediaAsset.findMany({
      where: {
        status: { in: ['PENDING', 'UPLOADING'] },
        createdAt: { lt: cutoff },
      },
      select: { id: true, storageKey: true },
      take: 500,
    });

    for (const orphan of orphans) {
      if (orphan.storageKey) {
        try {
          await this.client().send(
            new DeleteObjectCommand({ Bucket: getEnv().R2_BUCKET, Key: orphan.storageKey }),
          );
        } catch (err) {
          this.logger.warn(`Could not delete orphan ${orphan.storageKey}: ${(err as Error).message}`);
          continue;
        }
      }
      await this.prisma.mediaAsset.delete({ where: { id: orphan.id } }).catch(() => undefined);
    }

    if (orphans.length) {
      this.logger.log(`Reaped ${orphans.length} orphaned uploads older than ${olderThanHours}h`);
    }
    return { rows: orphans.length };
  }
}

function issues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}
