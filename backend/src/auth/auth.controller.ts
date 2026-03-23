import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/public.decorator';
import { AppSessionService } from '../app-session/app-session.service';
import { AuthService } from './auth.service';
import { ConfigService } from '@nestjs/config';

interface LoginDto {
  semel: number;
  username: string;
  password: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly appSessionService: AppSessionService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Get('schools')
  async getSchools() {
    try {
      return await this.authService.getSchools();
    } catch {
      throw new HttpException(
        { error: { code: 'UPSTREAM_ERROR', message: 'Failed to fetch school list' } },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body.semel || !body.username || !body.password) {
      throw new HttpException(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'semel, username and password are required',
            details: [],
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      'unknown';

    try {
      const { sessionToken, isFirstLogin } = await this.authService.login(
        body.semel,
        body.username,
        body.password,
        ip,
      );

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

      return { ok: true, isFirstLogin };
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      if (
        err instanceof Error &&
        (err as { statusCode?: number }).statusCode === 429
      ) {
        throw new HttpException(
          {
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many login attempts. Please try again later.',
              details: [],
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw err;
    }
  }

  @Delete('session')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.extractToken(req);
    if (token) {
      await this.appSessionService.revokeSession(token);
    }
    res.clearCookie('mashov_session', { path: '/' });
    return { ok: true };
  }

  @Get('me')
  async getMe(@Req() req: Request) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }
    return this.authService.getMe(userId);
  }

  private extractToken(request: Request): string | null {
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) return null;

    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const cookie of cookies) {
      const eqIdx = cookie.indexOf('=');
      if (eqIdx === -1) continue;
      const name = cookie.substring(0, eqIdx).trim();
      const value = cookie.substring(eqIdx + 1).trim();
      if (name === 'mashov_session') return value;
    }
    return null;
  }
}
