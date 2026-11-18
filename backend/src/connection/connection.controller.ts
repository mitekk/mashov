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

/**
 * @deprecated Superseded by `/school-links`, which can address one school of
 * several. Kept for one release because `frontend/src/api/connection.ts`
 * depends on it and a hard break buys nothing.
 *
 * `PUT /connection` means "the most recently used school" and `DELETE
 * /connection` means "every school" -- the only things they can mean, since
 * both predate a household having more than one. Both delegate to the same
 * service methods `/school-links` uses, so there is no second implementation
 * to drift.
 */
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
