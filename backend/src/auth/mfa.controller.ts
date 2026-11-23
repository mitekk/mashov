import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Public } from '../common/public.decorator';
import { MfaService } from './mfa.service';
import type { MfaMethod } from '../common/mashov-login/mashov-recovery.service';

/**
 * Answering a Mashov MFA challenge without leaving our app.
 *
 *   POST /api/v1/auth/mfa-challenges/:challengeId/code     -> 202 { ok }
 *   POST /api/v1/auth/mfa-challenges/:challengeId/session   -> 200 { ok, isFirstLogin } + cookie
 *
 * Resource-shaped per `.claude/rules/api.md`: a challenge is a resource, and
 * these create a code on it and a session from it. Both `@Public()` -- the
 * caller is mid-sign-in and has no session yet by definition.
 *
 * The `challengeId` is NOT a secret and not an authorisation: Mashov issued it
 * in the `403` that opened the challenge, and the one-time code is what
 * authorises. It is in the path because it names which challenge.
 */
@Controller('auth')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Post('mfa-challenges/:challengeId/code')
  @HttpCode(HttpStatus.ACCEPTED)
  async sendCode(
    @Param('challengeId') challengeId: string,
    @Body() body: SendMfaCodeDto,
  ) {
    if (!challengeId?.trim()) {
      throw validationError('challengeId is required');
    }
    if (body?.method !== 'email' && body?.method !== 'sms') {
      throw validationError("method must be 'email' or 'sms'");
    }

    return this.mfa.sendCode(challengeId, body.method);
  }

  @Public()
  @Post('mfa-challenges/:challengeId/session')
  @HttpCode(HttpStatus.OK)
  async createSession(
    @Param('challengeId') challengeId: string,
    @Body() body: CreateMfaSessionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const semel = Number(body?.semel);
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const code = typeof body?.code === 'string' ? body.code : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!challengeId?.trim()) {
      throw validationError('challengeId is required');
    }
    if (!Number.isFinite(semel) || semel <= 0 || !username) {
      throw validationError('semel and username are required');
    }
    if (!code.trim()) {
      throw validationError('code is required');
    }
    if (!password) {
      // Required on purpose. Mashov's own verify route rejects a password, but
      // our sixteen sync crons re-login by decrypting the stored credential --
      // so an MFA sign-in that carried no password would produce a working
      // session and no background sync at all, silently.
      throw validationError('password is required');
    }

    const result = await this.mfa.createSession(
      challengeId,
      { semel, username, password, code },
      clientIp(req),
    );

    // Minted exactly as `AuthController.login` mints it, so an MFA sign-in and
    // a password sign-in are the same session.
    const secureCookie =
      this.configService.get<string>('SESSION_SECURE_COOKIE') !== 'false';
    const lifetimeDays = Number(
      this.configService.get<string>('SESSION_LIFETIME_DAYS') ?? '30',
    );

    res.cookie('mashov_session', result.sessionToken, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'strict',
      path: '/',
      maxAge: lifetimeDays * 24 * 60 * 60 * 1000,
    });

    return { ok: true as const, isFirstLogin: result.isFirstLogin };
  }
}

interface SendMfaCodeDto {
  method: MfaMethod;
}

interface CreateMfaSessionDto {
  semel: number;
  username: string;
  /** Stored (encrypted) for the sync crons; stripped before the upstream call. */
  password: string;
  code: string;
}

/** Spelled as `AuthController.login` spells it, so both rate-limit the same client. */
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
