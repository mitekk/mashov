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
import { CredentialSetupService } from './credential-setup.service';
import { OtpService } from './otp.service';
import type { MfaMethod } from '../common/mashov-login/mashov-recovery.service';

/**
 * The last two in-app auth paths: a forced credential change, and passwordless
 * sign-in by one-time code.
 *
 *   POST /api/v1/auth/credentials              -> 200 + mashov_session
 *   POST /api/v1/auth/otp-requests             -> 202 { otpRequestId, method }
 *   POST /api/v1/auth/otp-requests/:id/session -> 200 + mashov_session
 *
 * All `@Public()`: every one of them is reached by someone who cannot complete
 * an ordinary sign-in. None may answer 401, for the same reason as the rest of
 * this surface -- `apiFetch` would hard-redirect and lose the form.
 */
@Controller('auth')
export class CredentialSetupController {
  constructor(
    private readonly setup: CredentialSetupService,
    private readonly otp: OtpService,
    private readonly configService: ConfigService,
  ) {}

  /** Satisfy `ChangePass` / `SetUsernameAndPass` / `CreateUsername`, and sign in. */
  @Public()
  @Post('credentials')
  @HttpCode(HttpStatus.OK)
  async setCredentials(
    @Body() body: SetCredentialsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const semel = Number(body?.semel);
    const username = str(body?.username).trim();
    const password = str(body?.password);

    if (!Number.isFinite(semel) || semel <= 0 || !username || !password) {
      throw validationError('semel, username and password are required');
    }

    const result = await this.setup.setCredentials(
      {
        semel,
        username,
        password,
        newPassword: body?.newPassword ? str(body.newPassword) : undefined,
        newUsername: body?.newUsername ? str(body.newUsername) : undefined,
        challengeId: body?.challengeId ? str(body.challengeId) : undefined,
      },
      clientIp(req),
    );

    this.setSessionCookie(res, result.sessionToken);
    return { ok: true as const, isFirstLogin: result.isFirstLogin };
  }

  /** Step 1 of passwordless sign-in. */
  @Public()
  @Post('otp-requests')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestOtp(@Body() body: RequestOtpDto, @Req() req: Request) {
    const semel = Number(body?.semel);
    const username = str(body?.username).trim();

    if (!Number.isFinite(semel) || semel <= 0 || !username) {
      throw validationError('semel and username are required');
    }
    if (body?.method !== 'email' && body?.method !== 'sms') {
      throw validationError("method must be 'email' or 'sms'");
    }

    return this.otp.request({ semel, username, method: body.method }, clientIp(req));
  }

  /** Step 2 of passwordless sign-in. */
  @Public()
  @Post('otp-requests/:otpRequestId/session')
  @HttpCode(HttpStatus.OK)
  async createOtpSession(
    @Param('otpRequestId') otpRequestId: string,
    @Body() body: CreateOtpSessionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const code = str(body?.code);
    if (!code.trim()) {
      throw validationError('code is required');
    }

    const result = await this.otp.createSession(otpRequestId, { code }, clientIp(req));

    this.setSessionCookie(res, result.sessionToken);
    return { ok: true as const, isFirstLogin: result.isFirstLogin };
  }

  /** Byte-identical to `AuthController.login`'s cookie, deliberately. */
  private setSessionCookie(res: Response, sessionToken: string): void {
    const secureCookie =
      this.configService.get<string>('SESSION_SECURE_COOKIE') !== 'false';
    const lifetimeDays = Number(
      this.configService.get<string>('SESSION_LIFETIME_DAYS') ?? '30',
    );

    res.cookie('mashov_session', sessionToken, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'strict',
      path: '/',
      maxAge: lifetimeDays * 24 * 60 * 60 * 1000,
    });
  }
}

interface SetCredentialsDto {
  semel: number;
  username: string;
  /** The current password; Mashov proves it before changing anything. */
  password: string;
  newPassword?: string;
  newUsername?: string;
  challengeId?: string;
}

interface RequestOtpDto {
  semel: number;
  username: string;
  method: MfaMethod;
}

interface CreateOtpSessionDto {
  code: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

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
