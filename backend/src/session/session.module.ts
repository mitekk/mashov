import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SessionService } from './session.service';
import { MashovHttpClient } from './mashov-http.client';
import { EncryptionService } from './encryption.service';

/**
 * Dead, and not instantiable.
 *
 * It declares `MashovHttpClient`, whose only constructor argument is
 * `MashovSessionService` -- which this module neither provides nor imports, so
 * Nest cannot resolve it. Nothing imports this module and nothing injects
 * `SessionService`, which is why that has never surfaced. Use
 * `MashovSessionModule`, which provides the client, the session service and
 * the encryption service together.
 */
@Module({
  imports: [ConfigModule],
  providers: [SessionService, MashovHttpClient, EncryptionService],
  exports: [SessionService, MashovHttpClient, EncryptionService],
})
export class SessionModule {}
