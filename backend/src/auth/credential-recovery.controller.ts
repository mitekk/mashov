import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/public.decorator';
import {
  CredentialRecoveryService,
  type RecoveryChannel,
} from './credential-recovery.service';

/**
 * The unauthenticated half of in-app Mashov auth.
 *
 * Resource-shaped paths per `.claude/rules/api.md` -- a recovery is a resource
 * you create and then set a password on, not a verb:
 *
 *   POST /api/v1/auth/credential-recoveries
 *   POST /api/v1/auth/credential-recoveries/:id/password
 *
 * Every route is `@Public()`: these exist precisely for someone who cannot sign
 * in. `frontend/src/middleware.ts` already treats all of `/api/v1/auth/` as
 * public, so no middleware change was needed.
 *
 * **No route here may answer 401.** `apiFetch` hard-redirects the browser to
 * `/auth/sign-in` on any 401 whose code is not `INVALID_CREDENTIALS`, which
 * would throw the parent off the reset form and lose a half-typed single-use
 * code. Validation failures are 400, policy failures 422, limits 429, outages
 * 502.
 */
@Controller('auth')
export class CredentialRecoveryController {
  constructor(private readonly recovery: CredentialRecoveryService) {}

  /**
   * Step 1. Always `202`, for a real account and an unknown one alike -- see
   * the no-enumeration note on the service.
   */
  @Public()
  @Post('credential-recoveries')
  @HttpCode(HttpStatus.ACCEPTED)
  async start(@Body() body: StartRecoveryDto, @Req() req: Request) {
    const semel = Number(body?.semel);
    const idNumber = typeof body?.idNumber === 'string' ? body.idNumber.trim() : '';
    const channel = body?.channel;
    const destination =
      typeof body?.destination === 'string' ? body.destination.trim() : '';

    if (!Number.isFinite(semel) || semel <= 0 || !idNumber) {
      throw validationError('semel and idNumber are required');
    }
    if (channel !== 'email' && channel !== 'sms') {
      throw validationError("channel must be 'email' or 'sms'");
    }
    if (!destination) {
      // Mashov requires it and checks it against what the school holds, so
      // there is nothing useful we could send without it. Shape only -- never
      // "we have no such contact", which would answer the enumeration
      // question this whole route exists to refuse.
      throw validationError(
        channel === 'sms'
          ? 'destination (mobile number) is required'
          : 'destination (email address) is required',
      );
    }

    return this.recovery.start(
      { semel, idNumber, channel, destination },
      clientIp(req),
    );
  }

  /** Step 2. */
  @Public()
  @Post('credential-recoveries/:recoveryId/password')
  @HttpCode(HttpStatus.OK)
  async completePassword(
    @Param('recoveryId') recoveryId: string,
    @Body() body: CompletePasswordDto,
    @Req() req: Request,
  ) {
    const code = typeof body?.code === 'string' ? body.code : '';
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
    const secondCode = typeof body?.secondCode === 'string' ? body.secondCode : undefined;

    if (!code.trim()) {
      throw validationError('code is required');
    }
    if (!newPassword) {
      throw validationError('newPassword is required');
    }

    return this.recovery.completePassword(
      recoveryId,
      { code, secondCode, newPassword },
      clientIp(req),
    );
  }
}

interface StartRecoveryDto {
  semel: number;
  idNumber: string;
  channel: RecoveryChannel;
  destination?: string;
}

interface CompletePasswordDto {
  code: string;
  secondCode?: string;
  newPassword: string;
}

/**
 * The caller's IP, spelled the same way `AuthController.login` spells it so the
 * recovery and login rate limiters bucket the same client together.
 */
function clientIp(req: Request): string {
  return (
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.ip ??
    'unknown'
  );
}

function validationError(message: string): HttpException {
  return new HttpException(
    { error: { code: 'VALIDATION_ERROR', message, details: [] } },
    HttpStatus.BAD_REQUEST,
  );
}
