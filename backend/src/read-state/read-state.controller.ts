import { Controller, Post, Body } from '@nestjs/common';
import { IsString, IsBoolean, IsOptional, IsNotEmpty } from 'class-validator';
import { ReadStateService } from './read-state.service';

class UpsertReadStateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  itemType?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  itemId?: string;

  @IsOptional()
  @IsBoolean()
  isRead?: boolean;

  @IsOptional()
  @IsBoolean()
  isHandled?: boolean;

  @IsOptional()
  @IsBoolean()
  clearAll?: boolean;
}

@Controller('read-state')
export class ReadStateController {
  constructor(private readonly readStateService: ReadStateService) {}

  @Post()
  async upsertReadState(@Body() body: UpsertReadStateDto) {
    if (body.clearAll === true) {
      return this.readStateService.clearAll();
    }

    if (!body.itemType || !body.itemId) {
      return { error: { code: 'VALIDATION_ERROR', message: 'itemType and itemId are required', details: [] } };
    }

    return this.readStateService.upsert({
      itemType: body.itemType,
      itemId: body.itemId,
      isRead: body.isRead,
      isHandled: body.isHandled,
    });
  }
}
