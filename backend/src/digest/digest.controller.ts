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
import { PrismaService } from '../prisma/prisma.service';
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
  @IsString()
  @MinLength(1)
  studentGuid!: string;
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
    private readonly prisma: PrismaService,
  ) {}

  @Get('recipients')
  async listRecipients(@Query() query: RecipientQueryDto) {
    return { data: await this.recipients.listFor(query.studentGuid) };
  }

  @Post('recipients')
  @HttpCode(HttpStatus.CREATED)
  async createRecipient(@Req() req: Request, @Body() body: CreateRecipientDto) {
    const userId = requireUserId(req);
    return { data: await this.recipients.create(userId, body) };
  }

  @Patch('recipients/:id')
  async updateRecipient(@Param('id') id: string, @Body() body: UpdateRecipientDto) {
    return { data: await this.recipients.update(id, body) };
  }

  @Delete('recipients/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRecipient(@Param('id') id: string): Promise<void> {
    await this.recipients.remove(id);
  }

  /**
   * Tighter than the global 50/min: this spends model tokens and sends real
   * messages to real people. Follows the 5/min precedent on POST /sync/refresh.
   */
  @Post('runs')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async run(@Req() req: Request, @Body() body: RunDigestDto) {
    requireUserId(req);
    return {
      data: await this.digest.runAll({
        studentGuid: body.studentGuid,
        dryRun: body.dryRun,
      }),
    };
  }

  @Get('deliveries')
  async listDeliveries(@Query() query: DeliveryQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = query.studentGuid ? { studentGuid: query.studentGuid } : {};

    const [rows, total] = await Promise.all([
      this.prisma.digestDelivery.findMany({
        where,
        orderBy: { runAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.digestDelivery.count({ where }),
    ]);

    return {
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
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
