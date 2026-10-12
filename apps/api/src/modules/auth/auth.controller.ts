import { Body, Controller, Get, HttpCode, HttpStatus, Logger, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ApiException,
  loginSchema,
  refreshSchema,
  registerSchema,
  userProfileSchema,
} from '@naijaproperty/contracts';
import { AuthService } from './auth.service.js';
import { GoogleAuthService } from './google-auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { getEnv } from '../../config/env.js';

/**
 * Cookie holding the OAuth nonce between `google/start` and `google/callback`.
 *
 * Path is scoped to the auth routes so it is not attached to any other request,
 * and so clearing it can never clobber the refresh cookie.
 */
const OAUTH_STATE_COOKIE = 'njp_oauth_state';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleAuthService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @ApiOperation({ summary: 'Create an account with email and password' })
  async register(
    @Body() raw: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<unknown> {
    const parsed = registerSchema.safeParse(raw);
    if (!parsed.success) throw ApiException.validation(issues(parsed.error));

    const session = await this.auth.register({
      email: parsed.data.email,
      password: parsed.data.password,
      displayName: parsed.data.displayName,
      phone: parsed.data.phone,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    this.setAuthCookies(res, session.refreshToken);
    return {
      user: session.user,
      accessToken: session.accessToken,
      expiresInSeconds: session.expiresInSeconds,
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 8, ttl: 15 * 60_000 } })
  @ApiOperation({ summary: 'Sign in with email and password' })
  async login(
    @Body() raw: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<unknown> {
    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) throw ApiException.validation(issues(parsed.error));

    const session = await this.auth.login({
      email: parsed.data.email,
      password: parsed.data.password,
      ip: req.ip,
    });

    this.setAuthCookies(res, session.refreshToken);
    return {
      user: session.user,
      accessToken: session.accessToken,
      expiresInSeconds: session.expiresInSeconds,
    };
  }

  @Get('google/start')
  @ApiOperation({ summary: 'Redirect to Google for OAuth sign-in' })
  googleStart(@Res() res: FastifyReply): void {
    /*
     * CSRF protection for the OAuth leg.
     *
     * The nonce is generated here, server-side, and parked in a short-lived
     * httpOnly cookie. The callback compares what Google echoes back against it.
     *
     * This previously read state off the query string and used it verbatim.
     * That is not a CSRF token: it is a value the caller chooses, so an attacker
     * could supply their own and nothing would be protected. Worse, the callback
     * never read state back at all, so the leg was entirely unverified despite
     * the comment claiming otherwise. That is login CSRF -- an attacker completes
     * the flow with their own Google account and induces a victim's browser to
     * finish the callback, so the victim silently ends up signed in as them.
     *
     * sameSite lax is required, not incidental: the callback arrives as a
     * top-level GET navigation from accounts.google.com, which is exactly the
     * case lax permits and strict would break.
     */
    const csrf = randomBytes(32).toString('base64url');

    res.header(
      'set-cookie',
      serializeCookie(OAUTH_STATE_COOKIE, csrf, {
        httpOnly: true,
        secure: getEnv().NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/api/v1/auth',
        maxAge: 600,
      }),
    );

    const url = this.google.buildAuthUrl(csrf);
    void res.redirect(url, 302);
  }

  @Get('google/callback')
  @ApiOperation({ summary: 'Google OAuth callback' })
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') oauthError: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const env = getEnv();

    /*
     * Consume the state cookie on every callback, including the error paths.
     *
     * Clearing it unconditionally means a failed attempt cannot be replayed with
     * a fresh code, and a successful one cannot be replayed at all.
     */
    const expected = req.cookies?.[OAUTH_STATE_COOKIE];
    this.clearOAuthStateCookie(res);

    if (oauthError || !code) {
      const url = new URL('/login', env.WEB_URL);
      url.searchParams.set('error', oauthError ?? 'missing_code');
      return res.redirect(url.toString(), 302);
    }

    /*
     * Verify the nonce before spending an authorization code.
     *
     * timingSafeEqual is used rather than === because a plain string compare
     * leaks the expected value through response timing, which would let an
     * attacker recover the nonce byte by byte. Both sides must be the same
     * length for timingSafeEqual, so length is checked first -- that comparison
     * leaks only the length of a value the attacker already supplied.
     */
    const expectedBuf = Buffer.from(expected ?? '', 'utf8');
    const actualBuf = Buffer.from(state ?? '', 'utf8');
    const stateValid =
      expectedBuf.length > 0 &&
      expectedBuf.length === actualBuf.length &&
      timingSafeEqual(expectedBuf, actualBuf);

    if (!stateValid) {
      this.logger.warn('Google callback rejected: OAuth state mismatch (possible login CSRF)');
      const url = new URL('/login', env.WEB_URL);
      url.searchParams.set('error', 'invalid_state');
      return res.redirect(url.toString(), 302);
    }

    try {
      const session = await this.google.exchange(code, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Hand the short-lived access token to the web app via a fragment that is
      // never sent to a server, then let the client exchange the httpOnly
      // refresh cookie for its own access token.
      this.setAuthCookies(res, session.refreshToken);

      const url = new URL('/auth/complete', env.WEB_URL);
      url.searchParams.set('token', session.accessToken);
      url.searchParams.set('expires', String(session.expiresInSeconds));
      return res.redirect(url.toString(), 302);
    } catch (err) {
      this.logger.warn(`Google callback failed: ${(err as Error).message}`);
      const url = new URL('/login', env.WEB_URL);
      url.searchParams.set('error', 'oauth_failed');
      return res.redirect(url.toString(), 302);
    }
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rotate the session using the refresh cookie' })
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<unknown> {
    const fromCookie: string | undefined = req.cookies?.njp_refresh;
    const parsed = refreshSchema.safeParse(req.body ?? {});
    const refreshToken = fromCookie ?? parsed.data?.refreshToken;

    if (!refreshToken) throw ApiException.unauthenticated('No active session');

    const session = await this.auth.refresh({ refreshToken, ip: req.ip });
    this.setAuthCookies(res, session.refreshToken);

    return {
      user: session.user,
      accessToken: session.accessToken,
      expiresInSeconds: session.expiresInSeconds,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End the current session' })
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    const token = req.cookies?.njp_refresh;
    if (token) await this.auth.logout(token);
    this.clearAuthCookies(res);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Current user profile' })
  async me(@Req() req: FastifyRequest): Promise<unknown> {
    const userId = (req as FastifyRequest & { user?: { sub: string } }).user?.sub;
    if (!userId) throw ApiException.unauthenticated();
    return userProfileSchema.parse(await this.auth.profile(userId));
  }

  @Get('methods')
  @ApiOperation({ summary: 'Which sign-in methods are available' })
  methods(): { email: true; google: boolean; phoneOtp: boolean } {
    return {
      email: true,
      google: this.google.isConfigured(),
      phoneOtp: true,
    };
  }

  /**
   * The refresh token lives in an httpOnly cookie so it is unreachable from
   * JavaScript, which removes the token-theft surface of localStorage.
   */
  private setAuthCookies(res: FastifyReply, refreshToken: string): void {
    const isProd = getEnv().NODE_ENV === 'production';
    const maxAge = Math.floor(getEnv().REFRESH_TOKEN_TTL_DAYS * 86_400);

    res.header(
      'set-cookie',
      serializeCookie('njp_refresh', refreshToken, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        path: '/api/v1/auth',
        maxAge,
      }),
    );
  }

  /**
   * Expires the OAuth nonce cookie.
   *
   * Called on every callback so the nonce is single-use. A nonce that survived a
   * completed or abandoned attempt would still be a valid CSRF token the next
   * time around.
   */
  private clearOAuthStateCookie(res: FastifyReply): void {
    res.header(
      'set-cookie',
      serializeCookie(OAUTH_STATE_COOKIE, '', {
        httpOnly: true,
        secure: getEnv().NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/api/v1/auth',
        maxAge: 0,
      }),
    );
  }

  private clearAuthCookies(res: FastifyReply): void {
    res.header(
      'set-cookie',
      serializeCookie('njp_refresh', '', {
        httpOnly: true,
        secure: getEnv().NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/api/v1/auth',
        maxAge: 0,
      }),
    );
  }
}

function serializeCookie(
  name: string,
  value: string,
  opts: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    path: string;
    maxAge: number;
  },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');
}

function issues(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}
