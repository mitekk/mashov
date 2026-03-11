import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { MashovHttpClient } from './mashov-http.client';
import { EncryptionService } from './encryption.service';

@Module({
  providers: [SessionService, MashovHttpClient, EncryptionService],
  exports: [SessionService, MashovHttpClient, EncryptionService],
})
export class SessionModule {}
