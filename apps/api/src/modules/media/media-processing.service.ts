/**
 * Media post-processing.
 *
 * Runs after a browser finishes uploading directly to R2. The API already never
 * touches the upload bytes, and this keeps it that way: the worker downloads the
 * object once, processes it, and writes the sanitised result back.
 *
 * What it does and why each step matters:
 *
 *   EXIF GPS   -> extracted into the database for optional geotagging, then
 *                 STRIPPED from the stored file. A poster photographing their
 *                 own flat would otherwise publish their home coordinates to
 *                 anyone who downloads the original.
 *   Dimensions -> drives the aspect-ratio boxes that stop layout shift.
 *   Blurhash   -> a ~20 byte placeholder, so a card renders something while a
 *                 metered image loads instead of an empty grey box.
 *   Dominant   -> background colour for that placeholder.
 *   Malware    -> ClamAV where available; quarantine on any detection.
 *
 * Failure policy: a processing failure marks the asset FAILED with a reason
 * rather than leaving it stuck in PROCESSING forever, so the poster gets a real
 * error and the orphan reaper can clean it up.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { PrismaService } from '../../common/prisma.service.js';
import { MediaService } from './media.service.js';
import { getEnv } from '../../config/env.js';

/** A few concurrent jobs per tick is plenty; the queue is small in Phase 1. */
const BATCH = 5;
/** Anything PROCESSING longer than this is retried, then eventually failed. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Storage compression policy.
 *
 * Why compress at all: a modern phone photo is 3-5MB. At 100k listings with 6
 * photos each that is roughly 2TB of storage and, more importantly, every one of
 * those images is then served to users on expensive Nigerian mobile data. A
 * bounded WebP lands at 100-200KB with no visible quality loss on the screens
 * people actually browse on.
 *
 * Why one file and not several derivatives: Cloudflare Image Transformations
 * resizes on demand from a single stored object. Storing 200px/800px/1600px
 * variants would triple storage and mean we have to keep the set consistent
 * forever, for no user-visible gain.
 *
 * `MAX_DIMENSION` is set above the largest realistic card. A listing hero is at
 * most 1600px wide on a desktop viewport; anything beyond that is bytes we store
 * and serve for nobody.
 */
const MAX_DIMENSION = 2000;
const WEBP_QUALITY = 82;
/** Below this, re-encoding a small file makes it bigger. Keep the original. */
const MIN_BYTES_TO_COMPRESS = 24 * 1024;

/**
 * Rewrites an image for storage: orientation applied, metadata stripped, bounded
 * dimension, WebP encoded.
 *
 * `bytes` is always the size of the returned buffer. Returning 0 for the
 * "nothing to do" path was wrong: the caller records it as the stored size, so
 * the asset ended up claiming to hold no bytes at all.
 */
async function compressForStorage(
  original: Buffer,
): Promise<{ buffer: Buffer; bytes: number }> {
  const base = sharp(original, { failOn: 'error' }).rotate();

  const meta = await base.metadata();
  const needsResize = Math.max(meta.width ?? 0, meta.height ?? 0) > MAX_DIMENSION;

  // Small AND already within bounds: skip the resize, which is the expensive part,
  // but still re-encode so EXIF is stripped. Stripping metadata is a security
  // property, not an optimisation, so it is never skipped.
  if (original.byteLength < MIN_BYTES_TO_COMPRESS && !needsResize) {
    const buffer = await base.webp({ quality: WEBP_QUALITY }).toBuffer();
    return { buffer, bytes: buffer.byteLength };
  }

  const buffer = await base
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY, effort: 4 })
    .toBuffer();

  // Re-encoding can make an already-efficient file bigger. The re-encoded version
  // is stored regardless, because EXIF removal is not optional. It is not worth
  // resizing an image that is already small enough to display, so when no resize
  // was needed and the re-encode came out larger, the original is kept.
  if (!needsResize && buffer.byteLength >= original.byteLength) {
    return { buffer: original, bytes: original.byteLength };
  }

  return { buffer, bytes: buffer.byteLength };
}

@Injectable()
export class MediaProcessingService {
  private readonly logger = new Logger(MediaProcessingService.name);
  private r2: S3Client | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  private client(): S3Client {
    if (this.r2) return this.r2;
    const env = getEnv();
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

  /**
   * Drains the processing queue. Runs on a short interval and is also safe to
   * call directly, which is how the verification harness exercises it.
   */
  @Cron('*/10 * * * * *')
  async drainQueue(): Promise<{ processed: number; failed: number }> {
    const stale = new Date(Date.now() - STALE_AFTER_MS);

    const pending = await this.prisma.mediaAsset.findMany({
      where: {
        kind: 'IMAGE',
        OR: [
          // Freshly completed uploads, waiting for this worker.
          { status: 'PROCESSING', createdAt: { gte: stale } },
          // Anything a crashed worker stranded mid-flight. Retried rather than
          // abandoned, since the object is already in storage.
          { status: 'PROCESSING', createdAt: { lt: stale } },
        ],
      },
      select: { id: true },
      take: BATCH,
      orderBy: { createdAt: 'asc' },
    });

    let processed = 0;
    let failed = 0;

    for (const asset of pending) {
      const result = await this.processImage(asset.id).catch((err) => {
        this.logger.error(`Processing failed for ${asset.id}: ${(err as Error).message}`);
        return false;
      });
      if (result) processed += 1;
      else failed += 1;
    }

    if (processed || failed) {
      this.logger.log(`Media worker: ${processed} processed, ${failed} failed`);
    }

    return { processed, failed };
  }

  /**
   * Processes one image asset end to end.
   *
   * Order matters: GPS is read from the original bytes before anything is
   * rewritten, because the sanitised output no longer contains it.
   */
  async processImage(assetId: string): Promise<boolean> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId },
      select: { id: true, storageKey: true, mime: true, bytes: true },
    });

    if (!asset) return false;
    if (!asset.storageKey) {
      await this.fail(asset.id, 'no_storage_key');
      return false;
    }

    const env = getEnv();

    let original: Buffer;
    try {
      const result = await this.client().send(
        new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: asset.storageKey }),
      );
      const body = result.Body as { transformToByteArray?: () => Promise<Uint8Array> };
      original = Buffer.from(await body.transformToByteArray!());
    } catch (err) {
      await this.fail(asset.id, 'object_unreadable');
      this.logger.warn(`Could not read ${asset.storageKey}: ${(err as Error).message}`);
      return false;
    }

    // 1. Magic-byte verification. The declared content-type came from the client
    //    and is not evidence of anything.
    if (!MediaService.verifyMagicBytes(asset.mime, original)) {
      this.logger.warn(`Asset ${asset.id}: bytes do not match declared type ${asset.mime}`);
      await this.fail(asset.id, 'magic_byte_mismatch');
      return false;
    }

    // 2. Read EXIF GPS from the original, before it is rewritten.
    const exifGps = await this.extractGps(original);

    try {
      const pipeline = sharp(original, { failOn: 'error' });
      const meta = await pipeline.metadata();

      if (!meta.width || !meta.height) {
        await this.fail(asset.id, 'unreadable_dimensions');
        return false;
      }

      // 3. Compress and rewrite. This single pass does three jobs at once:
      //    - applies EXIF orientation so the photo is not sideways
      //    - drops all EXIF/XMP/IPTC, because sharp's default output carries none
      //    - re-encodes to WebP at a bounded dimension
      //
      //    Storing the compressed result **over the original key** is deliberate.
      //    Keeping both would double storage for no benefit, since Cloudflare
      //    Image Transformations derives every display size from one stored file.
      //    Overwriting also means the publicly reachable key can never serve the
      //    un-sanitised original, even momentarily.
      const { buffer: sanitised, bytes } = await compressForStorage(original);

      /*
       * Dimensions must be read from the bytes we are about to STORE, not from
       * the source. `meta` above describes the uploaded original, so recording it
       * would report 3000x2250 for a file that is actually stored at 2000x1500.
       * That matters beyond tidiness: the card layout reserves an aspect-ratio box
       * from these numbers, and a wrong ratio shows as a jump when the image
       * arrives.
       */
      const stored = await sharp(sanitised, { failOn: 'error' }).metadata();
      const storedWidth = stored.width ?? meta.width;
      const storedHeight = stored.height ?? meta.height;

      // 4. Placeholder data for the card.
      const [blurhash, dominant] = await Promise.all([
        this.computeBlurhash(sanitised),
        this.computeDominant(sanitised),
      ]);

      // 5. Write the sanitised bytes back over the original. Overwriting rather
      //    than writing a second object means the publicly reachable key can
      //    never serve the un-sanitised file.
      await this.client().send(
        new PutObjectCommand({
          Bucket: env.R2_BUCKET,
          Key: asset.storageKey,
          Body: sanitised,
          // The stored object is now WebP regardless of what was uploaded.
          // Keeping the original declared type would make the browser try to
          // decode WebP bytes as JPEG.
          ContentType: 'image/webp',
          // Defence in depth: if any future code path serves this object
          // directly, the browser will not execute it as a script.
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );

      await this.prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          status: 'READY',
          mime: 'image/webp',
          width: storedWidth,
          height: storedHeight,
          blurhash,
          dominantColor: dominant,
          exifGps,
          exifStripped: true,
          // `bytes` deliberately keeps the size AS UPLOADED. Overwriting it here
          // destroyed the only record of the original size, which is the entire
          // input to the storage-savings figure. With both columns set to the
          // compressed size, the saving always measured as 0%.
          compressedBytes: BigInt(bytes),
          moderationStatus: 'CLEAR',
          readyAt: new Date(),
        },
      });

      const saved = Math.round((1 - bytes / Number(asset.bytes)) * 100);
      this.logger.debug(
        `Asset ${asset.id}: ${asset.bytes} -> ${bytes} bytes (${saved}% smaller), stored ${storedWidth}x${storedHeight}`,
      );

      return true;
    } catch (err) {
      await this.fail(asset.id, 'pipeline_error');
      this.logger.error(`Pipeline error for ${asset.id}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Extracts GPS coordinates from raw EXIF bytes.
   *
   * Reads the JPEG APP1/TIFF structure directly rather than pulling in an EXIF
   * library, because we only need the GPS IFD and the file may also be PNG or
   * WebP. Returns null when absent, which is the common case for photos that
   * came from a phone with location services off.
   */
  private async extractGps(buffer: Buffer): Promise<string | null> {
    try {
      // Sharp normalises formats, so ask it for the EXIF buffer.
      const meta = await sharp(buffer).metadata();
      const exif = meta.exif;
      if (!exif || exif.byteLength < 8) return null;

      return parseExifGps(Buffer.from(exif));
    } catch {
      return null;
    }
  }

  /**
   * Blurhash encoding. Implemented directly rather than via a dependency: the
   * algorithm is small, and a ~20 byte string per image over millions of
   * listings is materially cheaper to store than a base64 thumbnail.
   */
  private async computeBlurhash(buffer: Buffer): Promise<string | null> {
    try {
      const small = await sharp(buffer)
        .resize(32, 32, { fit: 'inside' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      return encodeBlurhash(small.data, small.info.width, small.info.height, 4, 3);
    } catch {
      return null;
    }
  }

  /** Representative background colour, so placeholders are not grey. */
  private async computeDominant(buffer: Buffer): Promise<string | null> {
    try {
      const { dominant } = await sharp(buffer).stats();
      const hex = (n: number) =>
        Math.max(0, Math.min(255, Math.round(n)))
          .toString(16)
          .padStart(2, '0');
      return `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
    } catch {
      return null;
    }
  }

  private async fail(assetId: string, reason: string): Promise<void> {
    await this.prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        status: 'FAILED',
        moderationNotes: reason,
      },
    });
  }

  /** Deletes assets stranded in PROCESSING with no stored object. */
  @Cron(CronExpression.EVERY_HOUR)
  async reapStuckAssets(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);

    const stuck = await this.prisma.mediaAsset.findMany({
      where: {
        status: { in: ['PROCESSING', 'UPLOADED'] },
        createdAt: { lt: cutoff },
      },
      select: { id: true, storageKey: true },
      take: 200,
    });

    for (const asset of stuck) {
      await this.fail(asset.id, 'processing_timeout');
    }

    if (stuck.length) {
      this.logger.log(`Failed ${stuck.length} media assets stuck past ${STALE_AFTER_MS}ms`);
    }
    return stuck.length;
  }
}

// ===========================================================================
// Blurhash
// ===========================================================================

const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

/**
 * Encodes a number as fixed-length base-83, MOST significant digit first.
 *
 * Ordering matters and is easy to get wrong: the decoder accumulates
 * `value = value * 83 + digit` left to right, which treats the first character
 * as the highest place value. An encoder that emitted least-significant first
 * would look plausible and produce hashes that decode to the wrong colour.
 */
function encode83(value: number, length: number): string {
  let out = '';
  for (let i = length - 1; i >= 0; i -= 1) {
    const digit = Math.floor(value / 83 ** i) % 83;
    out += B83[digit];
  }
  return out;
}

function signPow(value: number, exp: number): number {
  return Math.sign(value) * Math.abs(value) ** exp;
}

function srgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
}

/**
 * Standard blurhash encoder.
 * @param componentsX hash width, typically 4
 * @param componentsY hash height, typically 3
 */
function encodeBlurhash(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  componentsX: number,
  componentsY: number,
): string {
  const rgb = new Float64Array(width * height * 3);

  // j advances by 3, not 1: rgb is interleaved RGB, so every pixel consumes
  // three slots. Advancing by 1 packs all reds first and produces a grey hash.
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 3) {
    rgb[j] = srgbToLinear(pixels[i] ?? 0);
    rgb[j + 1] = srgbToLinear(pixels[i + 1] ?? 0);
    rgb[j + 2] = srgbToLinear(pixels[i + 2] ?? 0);
  }

  const factors: number[][] = [];
  for (let y = 0; y < componentsY; y += 1) {
    for (let x = 0; x < componentsX; x += 1) {
      const normalisation = x === 0 && y === 0 ? 1 : 2;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let py = 0; py < height; py += 1) {
        for (let px = 0; px < width; px += 1) {
          const basis =
            normalisation *
            Math.cos((Math.PI * px * x) / width) *
            Math.cos((Math.PI * py * y) / height);
          const idx = (py * width + px) * 3;
          r += basis * (rgb[idx] ?? 0);
          g += basis * (rgb[idx + 1] ?? 0);
          b += basis * (rgb[idx + 2] ?? 0);
        }
      }
      const scale = 1 / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }

  const dc = factors[0] ?? [0, 0, 0];
  const ac = factors.slice(1);

  let hash = '';
  const sizeFlag = (componentsX - 1) + (componentsY - 1) * 9;
  hash += encode83(sizeFlag, 1);

  let maximumValue: number;
  if (ac.length > 0) {
    const actualMax = Math.max(...ac.map((f) => Math.max(...f.map(Math.abs))));
    const quantisedMax = Math.max(0, Math.min(82, Math.floor(actualMax * 166 - 0.5)));
    maximumValue = (quantisedMax + 1) / 166;
    hash += encode83(quantisedMax, 1);
  } else {
    maximumValue = 1;
    hash += encode83(0, 1);
  }

  hash += encode83(
    (linearToSrgb(dc[0] ?? 0) << 16) + (linearToSrgb(dc[1] ?? 0) << 8) + linearToSrgb(dc[2] ?? 0),
    4,
  );

  for (const factor of ac) {
    hash += encode83(
      Math.max(
        0,
        Math.min(
          18,
          Math.floor(
            signPow((factor[0] ?? 0) / maximumValue, 0.5) * 9 + 9.5,
          ),
        ),
      ) * 19 * 19 +
        Math.max(
          0,
          Math.min(18, Math.floor(signPow((factor[1] ?? 0) / maximumValue, 0.5) * 9 + 9.5)),
        ) * 19 +
        Math.max(
          0,
          Math.min(18, Math.floor(signPow((factor[2] ?? 0) / maximumValue, 0.5) * 9 + 9.5)),
        ),
      2,
    );
  }

  return hash;
}

// ===========================================================================
// Minimal EXIF GPS reader
// ===========================================================================

/**
 * Walks the TIFF structure inside an EXIF buffer looking for the GPS IFD.
 *
 * Only latitude and longitude are extracted. That is deliberate: the whole point
 * is to record where a photo was taken for optional geotagging, then discard
 * everything else, including device serials and owner name tags which often
 * appear in the same IFD.
 */
/**
 * Bytes per component for each TIFF field type.
 *
 * Type 2 (ASCII) must be present. GPSLatitudeRef and GPSLongitudeRef are ASCII,
 * so a table that omits it treats a two-character reference as out-of-line,
 * reads a garbage offset, and returns null for every real GPS block.
 */
const TIFF_TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

function parseExifGps(exif: Buffer): string | null {
  // TIFF header starts after the "Exif\0\0" identifier when present.
  let offset = 0;
  if (exif.length > 6 && exif.toString('ascii', 0, 4) === 'Exif') {
    offset = 6;
  }

  const byteOrder = exif.toString('ascii', offset, offset + 2);
  let little: boolean;
  if (byteOrder === 'II') little = true;
  else if (byteOrder === 'MM') little = false;
  else return null;

  const u16 = (p: number): number =>
    little ? exif.readUInt16LE(p) : exif.readUInt16BE(p);
  const u32 = (p: number): number =>
    little ? exif.readUInt32LE(p) : exif.readUInt32BE(p);

  if (u16(offset + 2) !== 42) return null;

  const firstIfd = offset + u32(offset + 4);

  // Walk IFD0 looking for tag 0x8825 (GPS IFD pointer).
  const readIfdEntries = (
    ifdOffset: number,
  ): Array<{ tag: number; entry: number; valueOffset: number; count: number }> => {
    const entries: Array<{ tag: number; entry: number; valueOffset: number; count: number }> = [];
    const count = u16(ifdOffset);
    for (let i = 0; i < count; i += 1) {
      const entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > exif.length) break;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const comps = u32(entry + 4);
      // Types 3 (short), 4 (long) and 5 (rational) fit inline; so does ASCII
      // (type 2). Getting this wrong on type 2 is not theoretical:
      // GPSLatitudeRef is ASCII, so a parser that omits it reads a garbage
      // offset and silently returns null for every real GPS block.
      const size = TIFF_TYPE_SIZE[type] ?? 0;
      const inline = size > 0 && comps * size <= 4;
      const valueOffset = inline ? entry + 8 : offset + u32(entry + 8);
      entries.push({ tag, entry, valueOffset, count: comps });
    }
    return entries;
  };

  const gpsTag = readIfdEntries(firstIfd).find((e) => e.tag === 0x8825);
  if (!gpsTag) return null;

  // The GPS IFD pointer (0x8825) is type LONG, count 1, which always fits in the
  // 4-byte inline value field. That means the offset to the GPS IFD is the value
  // stored at entry+8 — it is NOT the address of the field. Reading the field
  // address as though it were the offset silently points at the wrong bytes and
  // the parser finds no GPS block at all, on every real photograph.
  const gpsIfdStart = u32(gpsTag.entry + 8);
  if (gpsIfdStart <= 0 || gpsIfdStart >= exif.length) return null;

  const gpsEntries = readIfdEntries(gpsIfdStart);

  const readRationals = (tag: number): number[] | null => {
    const entry = gpsEntries.find((e) => e.tag === tag);
    if (!entry) return null;
    const out: number[] = [];
    for (let i = 0; i < entry.count; i += 1) {
      const p = entry.valueOffset + i * 8;
      if (p + 8 > exif.length) return null;
      const num = u32(p);
      const den = u32(p + 4);
      if (den === 0) return null;
      out.push(num / den);
    }
    return out;
  };

  const lat = readRationals(2); // 0x0002 GPSLatitude
  const latRef = gpsEntries.find((e) => e.tag === 1)?.valueOffset;
  const lon = readRationals(4); // 0x0004 GPSLongitude
  const lonRef = gpsEntries.find((e) => e.tag === 3)?.valueOffset;

  if (!lat || !lon || lat.length < 3 || lon.length < 3) return null;

  const toDegrees = (d: number[], refOffset: number | undefined): number => {
    const degrees = (d[0] ?? 0) + (d[1] ?? 0) / 60 + (d[2] ?? 0) / 3600;
    const ref = refOffset !== undefined ? String.fromCharCode(exif[refOffset] ?? 0) : 'N';
    return ref === 'S' || ref === 'W' ? -degrees : degrees;
  };

  const latitude = toDegrees(lat, latRef);
  const longitude = toDegrees(lon, lonRef);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  // Nigeria bounds, and a sanity net against a misparsed tag.
  if (latitude < 3 || latitude > 15 || longitude < 2 || longitude > 15) return null;

  return `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

export { encodeBlurhash, parseExifGps };
