import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { FeedbackModule } from './feedback.module';
import { FeedbackService } from './feedback.service';
import { FeedbackNotifierService } from './feedback-notifier.service';
import { FeedbackNotifyTask } from './tasks/feedback-notify.task';
import { FeedbackTelegramSender } from './feedback-telegram.sender';
import { TelegramSender } from '../digest/senders/telegram.sender';
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

  it('resolves the notifier with its own feedback sender', async () => {
    // The wiring is the point: the notifier depends on FeedbackTelegramSender
    // by concrete class, and this module provides it itself rather than
    // injecting a provider from elsewhere.
    const moduleRef = await compile();

    expect(moduleRef.get(FeedbackService)).toBeInstanceOf(FeedbackService);
    expect(moduleRef.get(FeedbackNotifierService)).toBeInstanceOf(FeedbackNotifierService);
    expect(moduleRef.get(FeedbackNotifyTask)).toBeInstanceOf(FeedbackNotifyTask);
    expect(moduleRef.get(FeedbackTelegramSender)).toBeInstanceOf(FeedbackTelegramSender);
  });

  it('does not pull DigestModule into its graph', async () => {
    // Subclassing TelegramSender needs the class, not a provider, so this
    // module imports DigestModule nowhere -- and the parent-facing sender it
    // exports must therefore be unresolvable here. If this ever starts
    // resolving, something has re-imported DigestModule and the operator
    // notification is one typo away from going out as the bot parents talk to.
    const moduleRef = await compile();

    expect(() => moduleRef.get(TelegramSender)).toThrow();
  });

  it('does not pull the Mashov session or HTTP client into its graph', async () => {
    // Same bound as DigestModule and InboxNotifyModule: ADR-0023's egress hop
    // is a residential tinyproxy meant only for Mashov, HTTPS_PROXY is
    // process-wide, and a report's text must never traverse it.
    const moduleRef = await compile();

    expect(() => moduleRef.get('MashovHttpClient', { strict: false })).toThrow();
  });
});
