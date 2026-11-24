import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { Request } from 'express';
import {
  FEEDBACK_SUBJECTS,
  FeedbackService,
  type FeedbackReceipt,
  type FeedbackSubject,
} from './feedback.service';

/** Far past any real screen, far short of Postgres INTEGER's ceiling. */
const VIEWPORT_MAX = 100_000;

/** `{ data: … }`, the envelope the digest and telegram routes return. */
interface FeedbackResponse {
  data: FeedbackReceipt;
}

class CreateFeedbackDto {
  @IsIn(FEEDBACK_SUBJECTS)
  subject!: FeedbackSubject;

  /**
   * The parent's own wording, required only behind `אחר`.
   *
   * `@ValidateIf` SKIPS the field for every other subject rather than
   * rejecting it, and `whitelist: true` strips only undecorated properties --
   * so a stray value still reaches the service, which nulls it.
   */
  @ValidateIf((dto: CreateFeedbackDto) => dto.subject === 'other')
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(80)
  subjectOther?: string;

  /** Pre-filled from the Mashov profile and editable, so optional. */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string;

  /**
   * Trimmed BEFORE the length rules, so a textarea holding only spaces is a
   * 400 rather than a stored blank report.
   */
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(2000)
  content!: string;

  /**
   * The route the parent was on, e.g. `/children/<guid>`. Path only -- the
   * client sends no query or hash. The path itself DOES carry a child guid on
   * the child routes, deliberately: it is the parent's own child, in their own
   * household, and without it "the timetable is wrong" names no child.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  pagePath?: string;

  /**
   * Bounded at both ends. Unbounded, Prisma's `Int` maps to Postgres INTEGER
   * and an absurd value raises "integer out of range" -- which the catch-all
   * filter turns into a 500, a status .claude/rules/api.md reserves for the
   * genuinely unexpected. A browser cannot send one (`window.innerWidth` is
   * screen-bounded); a hand-made request can.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIEWPORT_MAX)
  viewportWidth?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIEWPORT_MAX)
  viewportHeight?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;
}

/**
 * The parent feedback channel. Write-only on purpose: there is no read path,
 * no reply thread and no notification -- whoever reads the table runs SQL.
 *
 * Behind the global `AppSessionGuard` like every other Phase 2 route, so a
 * report always has a household to snapshot.
 */
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  /**
   * Send one report.
   *
   * The `@Throttle` here is a crude per-IP backstop only. The limit that
   * matters is counted per user in the service: this one would lock out a
   * whole school NAT or both parents of one household.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async create(
    @Body() body: CreateFeedbackDto,
    @Req() req: Request,
  ): Promise<FeedbackResponse> {
    const userId = this.requireUserId(req);

    // From the header, not the body: the client has no reason to be trusted
    // with the one field whose purpose is telling us what it actually is.
    const userAgent = req.headers['user-agent'];

    return {
      data: await this.feedbackService.create(
        userId,
        body,
        typeof userAgent === 'string' ? userAgent : undefined,
      ),
    };
  }

  private requireUserId(req: Request): string {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }
    return userId;
  }
}
