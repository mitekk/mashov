import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MashovCredentialValidatorService } from './mashov-credential-validator.service';

@Module({
  imports: [ConfigModule],
  providers: [MashovCredentialValidatorService],
  exports: [MashovCredentialValidatorService],
})
export class MashovLoginModule {}
