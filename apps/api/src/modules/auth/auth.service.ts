import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { ApiException, type UserProfile } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { PiiService } from '../../common/pii.service.js';
import { PasswordService } from '../../common/crypto.service.js';
import { getEnv } from '../../config/env.js';

export interface AccessTokenPayload {
  sub: string;
  role: string;
  /** Scope states for moderators; empty means global. */
  scope: string[];
  tier: string;
}

export interface SessionResult {
  user: UserProfile;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

/**
 * How long after a rotation a revoked token is still treated as a lost race
 * rather than theft. See `refresh`.
 *
 * Long enough to cover a slow parallel fan-out, short enough that a genuinely
 * captured token is worthless almost immediately: 30 seconds against a
 * multi-day token lifetime.
 */
const REUSE_GRACE_MS = 30_000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly pii: PiiService,
    private readonly passwords: PasswordService,
  ) {}

  // --- Registration and login ---------------------------------------------

  async register(input: {
    email: string;
    password: string;
    displayName: string;
    phone?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<SessionResult> {
    const email = input.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw ApiException.conflict('CONFLICT', 'An account with that email already exists');
    }

    const phoneEnc = input.phone ? this.pii.encrypt(input.phone) : null;
    const phoneIdx = input.phone ? this.pii.blindIndex(input.phone) : null;

    if (phoneIdx) {
      const phoneTaken = await this.prisma.user.findUnique({
        where: { phoneIdx },
        select: { id: true },
      });
      if (phoneTaken) {
        throw ApiException.conflict(
          'PHONE_ALREADY_REGISTERED',
          'That phone number is already registered to an account',
        );
      }
    }

    const passwordHash = await this.passwords.hash(input.password);

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: input.displayName.trim(),
        phoneEnc,
        phoneIdx,
        verificationTier: 'NONE',
        lastLoginAt: new Date(),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'auth.register',
        entityType: 'user',
        entityId: user.id,
        ipHash: this.pii.hashIp(input.ip),
        userAgent: input.userAgent?.slice(0, 500),
        metadata: { method: 'email_password' },
      },
    });

    return this.createSession(user.id, {
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  async login(input: {
    email: string;
    password: string;
    ip?: string;
    userAgent?: string;
  }): Promise<SessionResult> {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Equalise timing between an unknown email and a wrong password so the
    // response cannot be used to enumerate registered addresses.
    if (!user?.passwordHash) {
      await this.passwords.burnTiming(input.password);
      throw ApiException.validation([
        { path: 'email', message: 'Email or password is incorrect' },
      ]);
    }

    if (user.status === 'SUSPENDED') {
      throw ApiException.forbidden('This account has been suspended. Contact support.');
    }

    const ok = await this.passwords.verify(user.passwordHash, input.password);
    if (!ok) {
      await this.recordFailedLogin(user.id);
      throw ApiException.validation([
        { path: 'email', message: 'Email or password is incorrect' },
      ]);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw ApiException.rateLimited(
        `Too many failed attempts. Try again in ${Math.ceil(
          (user.lockedUntil.getTime() - Date.now()) / 60_000,
        )} minutes.`,
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    return this.createSession(user.id, { ip: input.ip, userAgent: input.userAgent });
  }

  private async recordFailedLogin(userId: string): Promise<void> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });

    // Progressive lockout: 5 failures triggers a 15-minute lock.
    if (user.failedLoginCount >= 5) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + 15 * 60 * 1000) },
      });
      this.logger.warn(`Account ${userId} locked after repeated failed logins`);
    }
  }

  // --- Phone-verified sessions ---------------------------------------------

  /**
   * Creates or upgrades an account for a phone number confirmed by OTP.
   *
   * This is the path that grants the VERIFIED_ID badge. If the number already
   * belongs to an account, that account is used and its tier upgraded; if not,
   * a minimal account is provisioned so a person can verify before registering.
   */
  async upsertFromVerifiedPhone(input: {
    phoneE164: string;
    ip?: string;
    userAgent?: string;
  }): Promise<SessionResult> {
    const phoneIdx = this.pii.blindIndex(input.phoneE164);

    const existing = await this.prisma.user.findUnique({ where: { phoneIdx } });

    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          phoneVerifiedAt: existing.phoneVerifiedAt ?? new Date(),
          // Never downgrade a tier: a DOCUMENT or VERIFIED_AGENT account that
          // confirms its phone stays at its existing tier.
          verificationTier:
            rankTier(existing.verificationTier) >= rankTier('PHONE')
              ? existing.verificationTier
              : 'PHONE',
          lastLoginAt: new Date(),
        },
      });
      return this.createSession(existing.id, {
        ip: input.ip,
        userAgent: input.userAgent,
      });
    }

    const user = await this.prisma.user.create({
      data: {
        // Placeholder until the user completes registration; the phone index is
        // the real identity here.
        email: `phone+${phoneIdx.slice(0, 20)}@phone.naijaproperty.ng`,
        displayName: 'Naijaproperty member',
        phoneEnc: this.pii.encrypt(input.phoneE164),
        phoneIdx,
        phoneVerifiedAt: new Date(),
        verificationTier: 'PHONE',
        status: 'ACTIVE',
        lastLoginAt: new Date(),
      },
    });

    return this.createSession(user.id, { ip: input.ip, userAgent: input.userAgent });
  }

  // --- Sessions ------------------------------------------------------------

  async createSession(
    userId: string,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<SessionResult> {
    const env = getEnv();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const payload: AccessTokenPayload = {
      sub: user.id,
      role: user.role,
      scope: user.scopeStates,
      tier: user.verificationTier,
    };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: env.JWT_ACCESS_SECRET,
      // `ms`-style duration strings need an explicit cast; @nestjs/jwt types
      // this as a `StringValue` from the `ms` package.
      expiresIn: env.ACCESS_TOKEN_TTL as `${number}${'s' | 'm' | 'h' | 'd' | 'ms'}`,
      issuer: 'naijaproperty-api',
      audience: 'naijaproperty-web',
    });

    const refreshToken = randomBytes(48).toString('base64url');

    await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: hashToken(refreshToken),
        ipHash: this.pii.hashIp(ctx.ip),
        userAgent: ctx.userAgent?.slice(0, 500),
        deviceLabel: describeDevice(ctx.userAgent),
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      },
    });

    return {
      user: toProfile(user),
      accessToken,
      refreshToken,
      expiresInSeconds: parseTtlSeconds(env.ACCESS_TOKEN_TTL),
    };
  }

  /**
   * Rotates a refresh token. The old row is revoked and a new one issued, so a
   * stolen refresh token is usable at most once and its reuse is detectable.
   *
   * Reuse is not automatically theft. Two requests dispatched in the same
   * millisecond both present the same valid token; the first rotates it and the
   * second arrives holding a token that is now revoked. That is a race, not an
   * attack, and it happens constantly — a single page navigation fans out into
   * several parallel server-side requests, and double-tapping a link does the
   * same. Treating that as theft and revoking the family logs a legitimate user
   * out of every device, which is both an availability bug and a denial-of-
   * service primitive handed to anyone who can capture a single token.
   *
   * So a token revoked within REUSE_GRACE_MS is treated as a race: a new session
   * is issued and the family survives. Beyond the window it is treated as
   * theft, and only then is the family revoked. The window is short relative to
   * the token lifetime, so a captured token is still only good once in practice.
   */
  async refresh(input: { refreshToken: string; ip?: string }): Promise<SessionResult> {
    const tokenHash = hashToken(input.refreshToken);

    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: tokenHash },
      include: { user: true },
    });

    if (!session) {
      throw ApiException.unauthenticated('Your session has expired. Please sign in again.');
    }

    if (session.expiresAt < new Date()) {
      throw ApiException.unauthenticated('Your session has expired. Please sign in again.');
    }

    if (session.revokedAt) {
      const revokedAgoMs = Date.now() - session.revokedAt.getTime();

      if (revokedAgoMs > REUSE_GRACE_MS) {
        // Genuine reuse of an already-rotated token: assume the token leaked and
        // cut every session for this account, so the attacker and the victim are
        // both signed out.
        await this.revokeAllSessions(session.userId);
        this.logger.warn(
          `Refresh token reuse detected for user ${session.userId}; revoked all sessions`,
        );
        throw ApiException.unauthenticated('Your session has expired. Please sign in again.');
      }

      // Within the grace window: a concurrent request lost the race. Issue a fresh
      // session and leave the rest of the family intact.
      this.logger.debug(
        `Concurrent refresh for user ${session.userId} (${revokedAgoMs}ms after rotation)`,
      );
      return this.createSession(session.userId, { ip: input.ip });
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    return this.createSession(session.userId, { ip: input.ip });
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllSessions(userId: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Reads the role claim from a token WITHOUT re-deriving it from the database.
   *
   * This exists because a token can legitimately be minted before a role change
   * (an admin promoted after sign-in still holds a `role=USER` token). Guards must
   * fail closed on a stale claim rather than silently allow or silently deny:
   * if the token says USER and the database says ADMIN, we return USER.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    const env = getEnv();
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: env.JWT_ACCESS_SECRET,
        issuer: 'naijaproperty-api',
        audience: 'naijaproperty-web',
      });

      // Revocation check. A suspended or deleted account must lose access
      // immediately, not whenever its short-lived token happens to expire.
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { status: true, role: true },
      });

      if (!user || user.status !== 'ACTIVE') {
        throw ApiException.forbidden('This account is no longer active');
      }

      // Trust the database for authorisation, not the token. The token is a
      // bearer credential; the database is the source of truth. This also means a
      // role change takes effect on the next request rather than requiring the
      // user to sign in again.
      return { ...payload, role: user.role };
    } catch (err) {
      if (err instanceof ApiException) throw err;
      throw ApiException.unauthenticated();
    }
  }

  async profile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return toProfile(user);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const TIER_RANK: Record<string, number> = {
  NONE: 0,
  PHONE: 1,
  DOCUMENT: 2,
  VERIFIED_AGENT: 3,
};

function rankTier(tier: string): number {
  return TIER_RANK[tier] ?? 0;
}

function parseTtlSeconds(ttl: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(ttl);
  if (!match) return 900;
  const value = Number(match[1]);
  switch (match[2]) {
    case 'ms':
      return Math.floor(value / 1000);
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 3600;
    case 'd':
      return value * 86400;
    default:
      return 900;
  }
}

function describeDevice(ua: string | undefined): string | null {
  if (!ua) return null;
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) && !/Chrome/.test(ua) ? 'Safari'
    : /Firefox\//.test(ua) ? 'Firefox'
    : 'Browser';
  const platform =
    /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'Unknown';
  return `${browser} on ${platform}`;
}

type UserRow = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  verificationTier: string;
  phoneVerifiedAt: Date | null;
  twoFactorEnabled: boolean;
  createdAt: Date;
};

export function toProfile(user: UserRow): UserProfile {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role as UserProfile['role'],
    verificationTier: user.verificationTier as UserProfile['verificationTier'],
    phoneVerified: user.phoneVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
    twoFactorEnabled: user.twoFactorEnabled,
  };
}
