import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SchoolYearModule } from '../common/school-year/school-year.module';
import { MashovSessionService } from './mashov-session.service';
import { MashovHttpClient } from './mashov-http.client';
import { EncryptionService } from './encryption.service';

@Module({
  imports: [ConfigModule, SchoolYearModule],
  providers: [MashovSessionService, MashovHttpClient, EncryptionService],
  exports: [MashovSessionService, MashovHttpClient, EncryptionService],
})
export class MashovSessionModule {}
