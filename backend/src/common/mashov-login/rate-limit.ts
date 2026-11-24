import { HttpException, HttpStatus } from '@nestjs/common';
import { createHmac } from 'node:crypto';
/**
 * One sliding-window counter, shared by every limited route in this surface.
 *
 * Extracted rather than copied a fourth time: `AuthService.checkRateLimit`,
 * `CredentialRecoveryService` and `OtpService` each had their own, and the two
 * routes that shipped WITHOUT one -- `POST /auth/credentials` and both MFA
 * routes -- are exactly the kind of omission a shared helper makes visible.
 *
 * `RATE_LIMITED` rather than a per-surface code: the frontend already has copy
 * for it, and which of our buckets a caller exhausted is not information they
 * need.
 */
export async function countAgainstLimit(
  redis: { incr(key: string): Promise<number>; expire(key: string, seconds: number): Promise<void> },
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  if (count > limit) {
    throw new HttpException(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many attempts. Please try again later.',
          details: [],
        },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * A keyed, non-reversible handle on an identity, for rate-limit keys.
 *
 * NOT a bare `sha256`: a Mashov username is usually a 9-digit ID number, about
 * 10^9 candidates, so a plain digest is a rainbow table away from the original
 * -- which would defeat the point of hashing it at all.
 */
export function identityKeyHash(hashKey: Buffer, identity: string): string {
  return createHmac('sha256', hashKey).update(identity).digest('hex');
}
