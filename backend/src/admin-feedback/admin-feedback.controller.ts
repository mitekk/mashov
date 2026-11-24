import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Public } from '../common/public.decorator';
import { CloudflareAccessGuard } from '../admin-auth/cloudflare-access.guard';
import {
  ADMIN_FEEDBACK_DEFAULT_LIMIT,
  ADMIN_FEEDBACK_FILTERS,
  ADMIN_FEEDBACK_MAX_LIMIT,
  AdminFeedbackService,
  type AdminFeedbackDetail,
  type AdminFeedbackFilter,
  type AdminFeedbackPage,
} from './admin-feedback.service';

class ListFeedbackQuery {
  /**
   * Defaulted rather than optional-at-the-service: an unrecognised value is a
   * 400, not a silent fall back to "all". A filter that quietly widens is how
   * an operator ends up believing they have read everything.
   */
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? 'all' : value))
  @IsIn(ADMIN_FEEDBACK_FILTERS)
  filter: AdminFeedbackFilter = 'all';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_FEEDBACK_MAX_LIMIT)
  limit: number = ADMIN_FEEDBACK_DEFAULT_LIMIT;
}

interface AdminFeedbackDetailResponse {
  data: AdminFeedbackDetail;
}

/**
 * The operator triage surface. Read-and-triage only: nothing here writes a
 * report, and nothing here deletes one.
 *
 * ## Why this controller is `@Public()`
 *
 * It is not a hole. `AppSessionGuard` is registered as a global `APP_GUARD`
 * (app.module.ts) and demands a `mashov_session` cookie -- which an operator
 * does not have and should not need, because they are not a parent and have no
 * household. `@Public()` tells that guard to stand down; `CloudflareAccessGuard`
 * is then the real gate. Global guards run before route guards, so the ordering
 * holds: `@Public()` can only ever remove the PARENT check, never this one.
 *
 * Removing the `@UseGuards` line while leaving `@Public()` would expose every
 * parent's report, email included, to anyone who can reach the origin -- which,
 * today, is anyone who knows its IP. See ADR-0045 and
 * docs/ops/admin-access-setup.md.
 */
@Controller('admin/feedback')
@Public()
@UseGuards(CloudflareAccessGuard)
export class AdminFeedbackController {
  constructor(private readonly adminFeedback: AdminFeedbackService) {}

  @Get()
  async list(@Query() query: ListFeedbackQuery): Promise<AdminFeedbackPage> {
    return this.adminFeedback.list(query.filter, query.page, query.limit);
  }

  /** Stamps `readAt` on the first open -- a GET with a side effect, by design. */
  @Get(':id')
  async detail(@Param('id') id: string): Promise<AdminFeedbackDetailResponse> {
    return { data: await this.adminFeedback.detail(id) };
  }

  /**
   * `POST …/response`, not `…/mark-responded`: .claude/rules/api.md allows no
   * verb in a path. 200 rather than 201 -- it creates no addressable resource,
   * it records a state transition and hands back the row it changed.
   */
  @Post(':id/response')
  @HttpCode(HttpStatus.OK)
  async markResponded(@Param('id') id: string): Promise<AdminFeedbackDetailResponse> {
    return { data: await this.adminFeedback.markResponded(id) };
  }
}
