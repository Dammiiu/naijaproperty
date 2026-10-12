import { Injectable, Logger } from '@nestjs/common';
import { ApiException, type RegisterInput } from '@naijaproperty/contracts';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { PiiService } from '../../common/pii.service.js';
import { getEnv } from '../../config/env.js';

/**
 * Google OAuth. Exchanges the authorization code for a token, verifies the
 * ID token, and links to an existing account when the email already exists.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly pii: PiiService,
  ) {}

  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  }

  buildAuthUrl(state: string): string {
    const env = getEnv();
    if (!this.isConfigured()) {
      throw ApiException.internal('Google sign-in is not configured');
    }

    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${env.API_URL}/api/v1/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'select_account',
      state,
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchange(code: string, ctx: { ip?: string; userAgent?: string }) {
    const env = getEnv();
    if (!this.isConfigured()) {
      throw ApiException.internal('Google sign-in is not configured');
    }

    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      `${env.API_URL}/api/v1/auth/google/callback`,
    );

    let payload;
    try {
      const { tokens } = await client.getToken(code);
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token as string,
        audience: env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (err) {
      this.logger.warn(`Google token exchange failed: ${(err as Error).message}`);
      throw ApiException.unauthenticated('Google sign-in could not be verified');
    }

    if (!payload?.sub || !payload.email) {
      throw ApiException.unauthenticated('Google did not return an email address');
    }
    if (!payload.email_verified) {
      throw ApiException.unauthenticated('Your Google email is not verified');
    }

    const email = payload.email.toLowerCase();
    const displayName =
      payload.name?.trim() || email.split('@')[0]?.replace(/[._-]/g, ' ') || 'Member';
    const avatarUrl = payload.picture ?? null;

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ googleSub: payload.sub }, { email }] },
    });

    if (existing) {
      // Linking a Google identity to an existing password account is safe here
      // because Google has independently verified the email address.
      if (existing.googleSub !== payload.sub) {
        await this.prisma.user.update({
          where: { id: existing.id },
          data: { googleSub: payload.sub, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
        });
      }
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { lastLoginAt: new Date() },
      });
      return this.auth.createSession(existing.id, ctx);
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        googleSub: payload.sub,
        displayName,
        avatarUrl,
        emailVerifiedAt: new Date(),
        lastLoginAt: new Date(),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'auth.register',
        entityType: 'user',
        entityId: user.id,
        ipHash: this.pii.hashIp(ctx.ip),
        userAgent: ctx.userAgent?.slice(0, 500),
        metadata: { method: 'google_oauth' },
      },
    });

    return this.auth.createSession(user.id, ctx);
  }
}

export type { RegisterInput };
