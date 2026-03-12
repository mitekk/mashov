import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SessionService } from './session.service';
import { MashovHttpClient } from './mashov-http.client';
import { EncryptionService } from './encryption.service';

@Module({
  imports: [ConfigModule],
  providers: [SessionService, MashovHttpClient, EncryptionService],
  exports: [SessionService, MashovHttpClient, EncryptionService],
})
export class SessionModule {}
