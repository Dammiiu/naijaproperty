import {
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiException } from '@naijaproperty/contracts';
import type { FastifyRequest } from 'fastify';
import { AuthService } from './auth.service.js';

export interface AuthenticatedRequest extends FastifyRequest {
  user?: {
    sub: string;
    role: string;
    scope: string[];
    tier: string;
  };
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  // WebSocket and SSE clients cannot set headers, so they may pass the token as
  // a query parameter. It is short-lived and single-purpose.
  const q = (req.query as Record<string, unknown> | undefined)?.access_token;
  return typeof q === 'string' && q.length > 0 ? q : null;
}

/** Requires a valid access token. Populates `req.user`. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>() as AuthenticatedRequest;
    const token = bearerToken(req);

    if (!token) throw ApiException.unauthenticated();

    req.user = await this.auth.verifyAccessToken(token);
    return true;
  }
}

/**
 * Authenticates when a token is present, and allows the request either way.
 *
 * Exists for endpoints that are public but personalise for a signed-in viewer,
 * chiefly the listing detail page. That page is the SEO surface, so it must never
 * require a token; but a viewer who has already unlocked a contact, or the owner
 * looking at their own listing, must get the unlocked state back.
 *
 * Guarding it with `JwtAuthGuard` would 401 every anonymous visitor and
 * deindex the page. Leaving it unguarded means `req.user` is always undefined,
 * so `isOwner` and `hasRevealed` are permanently false and the unlocked address
 * and phone never render even after a successful reveal. Both failure modes look
 * plausible, which is why this is explicit rather than a flag on the other guard.
 *
 * A token that fails verification is ignored rather than rejected: the viewer
 * still gets the public page, just without their unlocked state. An expired
 * access token should not turn a public listing into an error page, and the
 * middleware refreshes it on the next navigation anyway.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>() as AuthenticatedRequest;
    const token = bearerToken(req);

    if (!token) return true;

    try {
      req.user = await this.auth.verifyAccessToken(token);
    } catch {
      // Anonymous. Deliberately not thrown.
    }

    return true;
  }
}

export const ROLES_KEY = 'naijaproperty:roles';

/** Requires the authenticated user to hold one of the listed roles. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * RBAC plus ABAC scope.
 *
 * Roles gate capability; scope gates which rows are visible. A MODERATOR scoped
 * to ['LA', 'OG'] can approve Lagos and Ogun listings but cannot load one in
 * Rivers, which is what stops a single compromised moderator account from
 * reaching the whole country.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>() as AuthenticatedRequest;
    if (!req.user) throw ApiException.unauthenticated();
    if (!required.includes(req.user.role)) throw ApiException.forbidden();

    return true;
  }
}

export const STAFF_ROLES = ['MODERATOR', 'ADMIN', 'SUPERADMIN'];
export const ADMIN_ROLES = ['ADMIN', 'SUPERADMIN'];

/** Checks whether a staff role may act on a listing in a given state. */
export function canActInState(
  user: { role: string; scope: string[] },
  stateCode: string,
): boolean {
  if (user.role === 'SUPERADMIN' || user.role === 'ADMIN') return true;
  if (user.role !== 'MODERATOR') return false;
  // An empty scope means the moderator is not yet assigned to any state.
  if (user.scope.length === 0) return false;
  return user.scope.includes(stateCode);
}
