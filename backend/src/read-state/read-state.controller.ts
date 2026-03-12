import { Controller, Post, Body, Res } from '@nestjs/common';
import { IsString, IsBoolean, IsOptional, IsNotEmpty } from 'class-validator';
import { Response } from 'express';
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
  async upsertReadState(
    @Body() body: UpsertReadStateDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (body.clearAll === true) {
      return this.readStateService.clearAll();
    }

    if (!body.itemType || !body.itemId) {
      res.status(200);
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
