import { Controller, Get, Param, Put, Body, Query } from '@nestjs/common';
import { IsArray, IsString, IsOptional, IsIn, IsBoolean, IsInt, Min, Max } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { MailService } from './mail.service';

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
  async getSummary() {
    return this.mailService.getSummary();
  }

  @Get('conversations')
  async getConversations(@Query() query: ConversationsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    // Support legacy newOnly param for backward compat with older clients/tests
    const filter: 'all' | 'new' | 'archived' =
      query.filter ?? (query.newOnly ? 'new' : 'all');
    return this.mailService.getConversations(page, limit, filter);
  }

  @Get('conversations/:id')
  async getConversation(@Param('id') id: string) {
    return this.mailService.getConversationDetail(id);
  }

  @Put('conversations/mark-read')
  async markRead(@Body() body: MarkReadDto) {
    return this.mailService.markConversationsRead(body.conversationIds);
  }

  @Put('conversations/mark-unread')
  async markUnread(@Body() body: MarkUnreadDto) {
    return this.mailService.markUnread(body.conversationIds);
  }

  @Put('conversations/archive')
  async archive(@Body() body: ArchiveDto) {
    return this.mailService.archive(body.conversationIds);
  }

  @Put('conversations/unarchive')
  async unarchive(@Body() body: UnarchiveDto) {
    return this.mailService.unarchive(body.conversationIds);
  }
}
