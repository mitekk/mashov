import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TelegramModule } from './telegram.module';
import { TelegramClient } from './telegram.client';
import { TelegramLinkService } from './telegram-link.service';
import { TelegramPollerService } from './telegram-poller.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Nest resolves providers at runtime, so a missing or circular dependency
 * compiles cleanly under tsc and only fails when the app boots. This test is
 * what catches that -- and this module has a real cross-module edge, since the
 * confirmation message goes out through the digest's TelegramSender.
 */
describe('TelegramModule', () => {
  async function compile() {
    return Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), TelegramModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
  }

  it('resolves the link service and everything it depends on', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(TelegramLinkService)).toBeInstanceOf(TelegramLinkService);
    expect(moduleRef.get(TelegramClient)).toBeInstanceOf(TelegramClient);
    expect(moduleRef.get(TelegramPollerService)).toBeInstanceOf(TelegramPollerService);
  });

  it('does not pull the Mashov session or HTTP client into its graph', async () => {
    // HTTPS_PROXY is process-wide and ADR-0023's hop is a residential tinyproxy
    // meant only for Mashov. A parent's chat id travels through this module, so
    // nothing here may reach that client.
    const moduleRef = await compile();

    expect(() => moduleRef.get('MashovHttpClient', { strict: false })).toThrow();
  });
});
