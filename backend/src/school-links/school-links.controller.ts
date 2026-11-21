import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
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

  /**
   * The parent's explicit yes to absorbing another household's school.
   *
   * Absent or false, a school another household owns answers
   * `409 MERGE_AVAILABLE` once the password is proven; the confirm is this
   * same POST with the credentials the form still holds. A merge revokes the
   * other household's sessions, so it never rides along on the first submit.
   */
  @IsOptional()
  @IsBoolean()
  confirmMerge?: boolean;
}

class UpdateSchoolLinkDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  password?: string;
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

  /** Re-validate and store new credentials for one school. */
  @Put(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @Body() body: UpdateSchoolLinkDto,
    @Req() req: Request,
  ): Promise<SchoolLink> {
    const userId = this.requireUser(req);
    return this.schoolLinksService.updateLink(userId, id, body);
  }

  /**
   * Unlink one school, deleting only its data.
   *
   * 204 with no body, per .claude/rules/api.md. The session is NOT revoked:
   * the parent still has a household, and signing them out of it because one
   * of two schools went away would be a worse outcome than the unlink they
   * asked for.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @Req() req: Request): Promise<void> {
    const userId = this.requireUser(req);
    await this.schoolLinksService.deleteLink(userId, id);
  }

  /** Unlink every school. The household keeps its AppUser and its session. */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAll(@Req() req: Request): Promise<void> {
    const userId = this.requireUser(req);
    await this.schoolLinksService.deleteLink(userId);
  }

  private requireUser(req: Request): string {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }
    return userId;
  }
}
