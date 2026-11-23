import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import { DigestRecipientService } from './digest-recipient.service';
import { DigestService } from './digest.service';

class CreateRecipientDto {
  @IsString()
  @MinLength(1)
  studentGuid!: string;

  @IsIn(['telegram', 'log'])
  channel!: string;

  @IsString()
  @MinLength(1)
  address!: string;

  @IsOptional()
  @IsString()
  displayName?: string;
}

class UpdateRecipientDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  displayName?: string;
}

class RunDigestDto {
  @IsOptional()
  @IsString()
  studentGuid?: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

class RecipientQueryDto {
  /**
   * Optional: the /more card asks "what am I subscribed to" without naming a
   * child, and joins names, classes and school labels client-side from the
   * already-cached children list rather than needing a server-side join.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  studentGuid?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

class DeliveryQueryDto {
  @IsOptional()
  @IsString()
  studentGuid?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/**
 * AppSessionGuard is registered globally in app.module.ts, so every route here
 * is authenticated with no extra wiring and no @Public() decorator.
 */
@Controller('digest')
export class DigestController {
  constructor(
    private readonly recipients: DigestRecipientService,
    private readonly digest: DigestService,
  ) {}

  @Get('recipients')
  async listRecipients(@Req() req: Request, @Query() query: RecipientQueryDto) {
    const userId = requireUserId(req);
    return this.recipients.list({
      userId,
      studentGuid: query.studentGuid,
      page: query.page,
      limit: query.limit,
    });
  }

  @Post('recipients')
  @HttpCode(HttpStatus.CREATED)
  async createRecipient(@Req() req: Request, @Body() body: CreateRecipientDto) {
    const userId = requireUserId(req);
    return { data: await this.recipients.create(userId, body) };
  }

  @Patch('recipients/:id')
  async updateRecipient(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: UpdateRecipientDto,
  ) {
    const userId = requireUserId(req);
    return { data: await this.recipients.update(id, body, userId) };
  }

  @Delete('recipients/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRecipient(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.recipients.remove(id, requireUserId(req));
  }

  /**
   * Tighter than the global 50/min: this spends model tokens and sends real
   * messages to real people. Follows the 5/min precedent on POST /sync/refresh.
   */
  @Post('runs')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async run(@Req() req: Request, @Body() body: RunDigestDto) {
    return {
      data: await this.digest.runAll({
        studentGuid: body.studentGuid,
        dryRun: body.dryRun,
        // Scoped to the caller's own children. There is no child -> parent FK
        // to validate a studentGuid against (ADR-0026), so without this an
        // authenticated user could post another household's guid and both send
        // that family a real message and consume the claims their own 13:00
        // run needed.
        userId: requireUserId(req),
        // A parent pressing the button is asking for the digest *now*. The
        // per-child dismissal gate exists to stop unattended noise from the
        // hourly cron, not to refuse an explicit request (ADR-0040).
        ignoreDismissalGate: true,
      }),
    };
  }

  @Get('deliveries')
  async listDeliveries(@Req() req: Request, @Query() query: DeliveryQueryDto) {
    return this.recipients.listDeliveries(requireUserId(req), query);
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
