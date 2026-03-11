import { Controller, Get, Param, Put, Body, Query } from '@nestjs/common';
import { IsArray, IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { MailService } from './mail.service';

class PaginationQueryDto {
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

@Controller('mail')
export class MailController {
  constructor(private readonly mailService: MailService) {}

  @Get('summary')
  async getSummary() {
    return this.mailService.getSummary();
  }

  @Get('conversations')
  async getConversations(@Query() query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return this.mailService.getConversations(page, limit);
  }

  @Get('conversations/:id')
  async getConversation(@Param('id') id: string) {
    return this.mailService.getConversationDetail(id);
  }

  @Put('conversations/mark-unread')
  async markUnread(@Body() body: MarkUnreadDto) {
    return this.mailService.markUnread(body.conversationIds);
  }

  @Put('conversations/archive')
  async archive(@Body() body: ArchiveDto) {
    return this.mailService.archive(body.conversationIds);
  }
}
