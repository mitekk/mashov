import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { FeedbackModule } from './feedback.module';
import { FeedbackService } from './feedback.service';
import { FeedbackNotifierService } from './feedback-notifier.service';
import { FeedbackNotifyTask } from './tasks/feedback-notify.task';
import { PrismaService } from '../prisma/prisma.service';

describe('FeedbackModule', () => {
  async function compile() {
    return Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), FeedbackModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
  }

  it('resolves the notifier with the Telegram sender DigestModule exports', async () => {
    // The wiring is the point: the notifier depends on TelegramSender by class
    // token across a module boundary, which only resolves because DigestModule
    // exports it.
    const moduleRef = await compile();

    expect(moduleRef.get(FeedbackService)).toBeInstanceOf(FeedbackService);
    expect(moduleRef.get(FeedbackNotifierService)).toBeInstanceOf(FeedbackNotifierService);
    expect(moduleRef.get(FeedbackNotifyTask)).toBeInstanceOf(FeedbackNotifyTask);
  });

  it('does not pull the Mashov session or HTTP client into its graph', async () => {
    // Same bound as DigestModule and InboxNotifyModule: ADR-0023's egress hop
    // is a residential tinyproxy meant only for Mashov, HTTPS_PROXY is
    // process-wide, and a report's text must never traverse it.
    const moduleRef = await compile();

    expect(() => moduleRef.get('MashovHttpClient', { strict: false })).toThrow();
  });
});
