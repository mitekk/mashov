import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DigestModule } from './digest.module';
import { DigestService } from './digest.service';
import { DigestRecipientService } from './digest-recipient.service';
import { DigestTask } from './tasks/digest.task';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Nest resolves providers at runtime, so a missing or circular dependency
 * compiles cleanly under tsc and only fails when the app boots. This test is
 * what catches that.
 */
describe('DigestModule', () => {
  async function compile() {
    return Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DigestModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
  }

  it('resolves the orchestrator and everything it depends on', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(DigestService)).toBeInstanceOf(DigestService);
    expect(moduleRef.get(DigestRecipientService)).toBeInstanceOf(DigestRecipientService);
    expect(moduleRef.get(DigestTask)).toBeInstanceOf(DigestTask);
  });

  it('does not pull the Mashov session or HTTP client into its graph', async () => {
    // ADR-0023's egress hop is a residential tinyproxy meant only for Mashov,
    // and HTTPS_PROXY is process-wide. The digest egresses to third parties, so
    // nothing here may reach that client.
    const moduleRef = await compile();

    expect(() => moduleRef.get('MashovHttpClient', { strict: false })).toThrow();
  });
});
