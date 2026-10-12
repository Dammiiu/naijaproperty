import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Throttler guard that can be bypassed for end-to-end verification.
 *
 * `NJP_E2E=1` disables throttling entirely for the process. Raising the numbers
 * configured in `ThrottlerModule.forRoot` is not enough, because most sensitive
 * routes also carry a per-route `@Throttle({ limit: N })` decorator and that
 * literal wins over the module default. Verification harnesses make dozens of
 * calls from a single IP, which the auth limits correctly read as abuse, so they
 * would otherwise report rate limiting instead of product behaviour.
 *
 * Guarded three ways so it cannot weaken a real deployment:
 *   - `main.ts` throws at boot if NJP_E2E=1 together with NODE_ENV=production
 *   - the flag is read once at module load, never per request
 *   - the bypass is logged loudly at startup
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private static readonly bypass =
    process.env.NJP_E2E === '1' && process.env.NODE_ENV !== 'production';

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (AppThrottlerGuard.bypass) return true;
    return super.canActivate(context);
  }
}
