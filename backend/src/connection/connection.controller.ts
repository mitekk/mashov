import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConnectionService } from './connection.service';

interface UpdateConnectionDto {
  username?: string;
  password?: string;
}

@Controller('connection')
export class ConnectionController {
  constructor(private readonly connectionService: ConnectionService) {}

  @Put()
  @HttpCode(HttpStatus.OK)
  async updateConnection(@Body() body: UpdateConnectionDto, @Req() req: Request) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }
    return this.connectionService.updateConnection(userId, body.username, body.password);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  async deleteConnection(@Req() req: Request) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }
    return this.connectionService.deleteConnection(userId);
  }
}
