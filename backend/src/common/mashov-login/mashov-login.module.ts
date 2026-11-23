import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MashovCredentialValidatorService } from './mashov-credential-validator.service';
import { MashovRecoveryService } from './mashov-recovery.service';

@Module({
  imports: [ConfigModule],
  providers: [MashovCredentialValidatorService, MashovRecoveryService],
  exports: [MashovCredentialValidatorService, MashovRecoveryService],
})
export class MashovLoginModule {}
