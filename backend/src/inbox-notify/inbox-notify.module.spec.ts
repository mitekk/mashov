import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { InboxNotifyModule } from './inbox-notify.module';
import { InboxNotifyService } from './inbox-notify.service';
import { InboxNotifyTask } from './tasks/inbox-notify.task';
import { PrismaService } from '../prisma/prisma.service';

describe('InboxNotifyModule', () => {
  it('resolves the notifier with the Telegram sender DigestModule exports', async () => {
    // The wiring is the point: the notifier depends on TelegramSender by class
    // token across a module boundary, which only resolves because DigestModule
    // exports it.
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), InboxNotifyModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(InboxNotifyService)).toBeInstanceOf(InboxNotifyService);
    expect(moduleRef.get(InboxNotifyTask)).toBeInstanceOf(InboxNotifyTask);
  });

  it('does not pull the Mashov session or HTTP client into its graph', async () => {
    // Same bound as DigestModule: ADR-0023's egress hop is a residential
    // tinyproxy meant only for Mashov, HTTPS_PROXY is process-wide, and a
    // parent's mail must never traverse it.
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), InboxNotifyModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(() => moduleRef.get('MashovHttpClient', { strict: false })).toThrow();
  });
});
