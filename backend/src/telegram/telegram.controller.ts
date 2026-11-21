import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsString,
  MinLength,
} from 'class-validator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { TelegramLinkService } from './telegram-link.service';

class CreateTelegramLinkDto {
  @IsArray()
  @ArrayNotEmpty()
  // A household has a handful of children, not a hundred. The cap is what
  // stops one request fanning out into an unbounded visibility check.
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  studentGuids!: string[];
}

/**
 * The parent-facing half of the Telegram link.
 *
 * Mounted under `digest` beside DigestController, because a link exists only to
 * produce digest recipients -- the resource is the same family. AppSessionGuard
 * is registered globally in app.module.ts, so every route here is authenticated
 * with no extra wiring and no @Public() decorator.
 */
@Controller('digest')
export class TelegramController {
  constructor(private readonly links: TelegramLinkService) {}

  /**
   * Tighter than the global 50/min. The code it returns is a credential: a
   * guessed one would bind the guesser's chat to a victim's account, so the
   * rate at which they can be produced is worth bounding. Follows the 5/min
   * precedent on POST /sync/refresh and POST /digest/runs.
   */
  @Post('telegram-links')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async createLink(@Req() req: Request, @Body() body: CreateTelegramLinkDto) {
    const userId = requireUserId(req);
    return { data: await this.links.mint(userId, body.studentGuids) };
  }

  /**
   * What the wizard's third step polls while it waits for the START.
   *
   * Scoped to the caller's own userId as well as the code, so a code is never
   * a bearer token for another user's link status.
   */
  @Get('telegram-links/:code')
  async readLink(@Req() req: Request, @Param('code') code: string) {
    const userId = requireUserId(req);
    return { data: await this.links.statusFor(userId, code) };
  }

  /** Turns Telegram off entirely. Per-child off is PATCH recipients/:id. */
  @Delete('telegram-links')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteLinks(@Req() req: Request): Promise<void> {
    await this.links.disconnect(requireUserId(req));
  }
}

function requireUserId(req: Request): string {
  const userId = req.user?.userId;
  if (!userId) {
    throw new UnauthorizedException({
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
    });
  }
  return userId;
}
