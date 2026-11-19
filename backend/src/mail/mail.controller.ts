import { Controller, Get, Param, Put, Body, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { IsArray, IsString, IsOptional, IsIn, IsBoolean, IsInt, Min, Max } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { MailService } from './mail.service';
import type { Request, Response } from 'express';

class ConversationsQueryDto {
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

  @IsOptional()
  @IsIn(['all', 'new', 'archived'])
  filter?: 'all' | 'new' | 'archived' = 'all';

  /** The school whose mailbox to show; omitted, every mailbox. */
  @IsOptional()
  @IsString()
  schoolId?: string;

  /** @deprecated use filter=new instead */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  newOnly?: boolean = false;
}

class MarkReadDto {
  @IsArray()
  @IsString({ each: true })
  conversationIds!: string[];
}

class MarkUnreadDto {
  @IsArray()
  @IsString({ each: true })
  conversationIds!: string[];
}

class ArchiveDto {
  @IsArray()
  @IsString({ each: true })
  conversationIds!: string[];
}

class UnarchiveDto {
  @IsArray()
  @IsString({ each: true })
  conversationIds!: string[];
}

@Controller('mail')
export class MailController {
  constructor(private readonly mailService: MailService) {}

  @Get('summary')
  async getSummary(@Req() req: Request) {
    return this.mailService.getSummary(req.user?.userId);
  }

  @Get('conversations')
  async getConversations(@Query() query: ConversationsQueryDto, @Req() req: Request) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    // Support legacy newOnly param for backward compat with older clients/tests
    const filter: 'all' | 'new' | 'archived' =
      query.filter ?? (query.newOnly ? 'new' : 'all');
    return this.mailService.getConversations(
      page,
      limit,
      filter,
      query.schoolId,
      req.user?.userId,
    );
  }

  @Get('conversations/:id')
  async getConversation(@Param('id') id: string, @Req() req: Request) {
    return this.mailService.getConversationDetail(id, req.user?.userId);
  }

  @Get('conversations/:conversationId/messages/:messageId/files/:fileId')
  async downloadMessageAttachment(
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: Response,
    @Req() req: Request,
  ) {
    const file = await this.mailService.downloadMessageAttachment(
      conversationId,
      messageId,
      fileId,
      req.user?.userId,
    );

    response.setHeader(
      'Content-Type',
      file.contentType ?? 'application/octet-stream',
    );
    response.setHeader(
      'Content-Disposition',
      file.contentDisposition
        ?? `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName ?? fileId)}`,
    );

    return new StreamableFile(file.buffer);
  }

  @Put('conversations/mark-read')
  async markRead(@Body() body: MarkReadDto, @Req() req: Request) {
    return this.mailService.markConversationsRead(body.conversationIds, req.user?.userId);
  }

  @Put('conversations/mark-unread')
  async markUnread(@Body() body: MarkUnreadDto, @Req() req: Request) {
    return this.mailService.markUnread(body.conversationIds, req.user?.userId);
  }

  @Put('conversations/archive')
  async archive(@Body() body: ArchiveDto, @Req() req: Request) {
    return this.mailService.archive(body.conversationIds, req.user?.userId);
  }

  @Put('conversations/unarchive')
  async unarchive(@Body() body: UnarchiveDto, @Req() req: Request) {
    return this.mailService.unarchive(body.conversationIds, req.user?.userId);
  }
}
