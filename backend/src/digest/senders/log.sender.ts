import { Injectable, Logger } from '@nestjs/common';
import { DigestSender } from './digest-sender.interface';

/**
 * Sends nothing and records what it would have sent. Used in dev and tests,
 * and for `DIGEST_DRY_RUN`, which defaults to true so the first deploy of this
 * feature cannot message a parent by accident.
 */
@Injectable()
export class LogSender implements DigestSender {
  readonly channel = 'log';

  private readonly logger = new Logger(LogSender.name);

  async send(address: string, text: string): Promise<void> {
    this.logger.log(`[dry run] would send to ${address}:\n${text}`);
  }
}
