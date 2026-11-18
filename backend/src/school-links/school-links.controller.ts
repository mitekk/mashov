import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { IsInt, IsString, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import { SchoolLinksService } from './school-links.service';
import type { SchoolLink } from './school-links.service';

interface PaginatedSchoolLinks {
  data: SchoolLink[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

class CreateSchoolLinkDto {
  @Type(() => Number)
  @IsInt()
  semel!: number;

  @IsString()
  @MinLength(1)
  username!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

/**
 * The connected-schools resource.
 *
 * Plural noun, no verb, flat, versioned by the global prefix -- per
 * .claude/rules/api.md. Paginated even though a household is capped at four
 * links: `PaginatedResponse<T>` already exists on the client, so conforming
 * costs nothing and a later cap change needs no shape change.
 */
@Controller('school-links')
export class SchoolLinksController {
  constructor(private readonly schoolLinksService: SchoolLinksService) {}

  @Get()
  async list(@Req() req: Request): Promise<PaginatedSchoolLinks> {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }

    const data = await this.schoolLinksService.listLinks(userId);

    return {
      data,
      pagination: {
        page: 1,
        limit: data.length === 0 ? 20 : data.length,
        total: data.length,
        totalPages: data.length === 0 ? 0 : 1,
      },
    };
  }

  /**
   * Link another Mashov account.
   *
   * 201 with the created link, and deliberately without waiting for the sync:
   * the children arrive in the login response, so the school is immediately
   * usable, while the rest takes minutes the proxy would not hold open.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreateSchoolLinkDto,
    @Req() req: Request,
  ): Promise<SchoolLink> {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }

    return this.schoolLinksService.createLink(userId, body);
  }
}
