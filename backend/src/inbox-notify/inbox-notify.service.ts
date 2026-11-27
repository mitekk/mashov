import { createHash, randomUUID } from 'crypto';
import {
  TELEGRAM_CAPTION_LABEL_BUDGET,
  TELEGRAM_CAPTION_NAME_BUDGET,
  clampLine,
  escapeTelegramHtml,
} from '../telegram/telegram-html';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { activeConnectionIdsFor } from '../common/student-links';
import { STALE_CLAIM_MS } from '../digest/digest-checker.service';
import { jerusalemDayBounds } from '../digest/digest-deadline.service';
import { DigestSender } from '../digest/senders/digest-sender.interface';
import { TelegramSender } from '../digest/senders/telegram.sender';
import { isPermanentTelegramFailure } from '../telegram/telegram-http';
import { resolvePublicBaseUrl } from '../telegram/public-base-url';
import {
  FetchedMedia,
  MEDIA_DELIVERY,
  MediaAttachmentRef,
  MediaDelivery,
  NO_MEDIA_DELIVERY,
  NO_UPSTREAM_MAIL,
  UPSTREAM_MAIL,
  UpstreamMail,
} from '../telegram-media/media-delivery.interface';
import { parseAttachmentList } from '../children/attachment-parser';
import { isWithinQuietHours } from './quiet-hours';
import {
  DEFAULT_BODY_CHARS,
  InboxNotifiableMessage,
  renderInboxMessage,
  renderInboxSummary,
} from './inbox-notify.template';

const DEFAULT_TIMEZONE = 'Asia/Jerusalem';
const DEFAULT_QUIET_FROM = '21:00';
const DEFAULT_QUIET_TO = '07:00';

/**
 * How far back a run will look for mail it has not notified about.
 *
 * It is the carry-over mechanism, not just a bound: mail that arrives inside
 * the quiet window is sent when the window closes because it is still inside
 * this lookback. Shorter than the window is long would lose it.
 */
const DEFAULT_LOOKBACK_HOURS = 24;

/**
 * Above this, one summary goes out instead of the messages themselves.
 *
 * The alternative is a burst of N messages into one chat: Telegram rate-limits
 * it, and a parent reads it as the app malfunctioning. The whole batch is
 * still claimed and confirmed, so the next run does not then send it one by
 * one.
 */
const DEFAULT_MAX_PER_RUN = 5;

export type InboxNotifyStatus = 'sent' | 'skipped_empty' | 'failed' | 'dry_run';

export interface InboxNotifyResult {
  userId: string;
  channel: string;
  address: string;
  status: InboxNotifyStatus;
  /** Messages this address was told about, summary or not. */
  messageCount: number;
  /** True when one summary went out in place of the messages. */
  summarized: boolean;
  error?: string;
}

export interface InboxNotifyRunOptions {
  now?: Date;
  dryRun?: boolean;
  /** Run one parent only -- used by tests and any manual trigger. */
  userId?: string;
  /** For a deliberate manual run; the cron never sets it. */
  ignoreQuietHours?: boolean;
}

/** Exactly the message columns the notification is allowed to read. */
const MESSAGE_SELECT = {
  messageId: true,
  conversationId: true,
  senderId: true,
  senderName: true,
  subject: true,
  bodyHtmlSanitized: true,
  bodyTextPreview: true,
  sendTime: true,
  isNew: true,
  householdConnectionId: true,
  // Metadata only. The bytes are fetched later, per message, and only when a
  // chat is actually being written to.
  files: true,
} as const;

type MessageRow = {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  subject: string;
  bodyHtmlSanitized: string | null;
  bodyTextPreview: string | null;
  sendTime: Date;
  isNew: boolean;
  householdConnectionId: string | null;
  files: unknown;
};

type ConversationRow = {
  conversationId: string;
  householdConnectionId: string | null;
  locallyReadThroughAt: Date | null;
};

/** Whether this row already carries something the chat could show. */
function hasBody(message: Pick<MessageRow, 'bodyHtmlSanitized' | 'bodyTextPreview'>): boolean {
  return (
    (message.bodyHtmlSanitized ?? '').trim().length > 0 ||
    (message.bodyTextPreview ?? '').trim().length > 0
  );
}

/** A candidate message plus the conversation fields the filters need. */
interface Candidate extends InboxNotifiableMessage {
  contentHash: string;
  /** The message's attachments, as the enumeration read them. */
  attachments: MediaAttachmentRef[];
}

/**
 * Notifies a parent's linked chats about new school mail.
 *
 * Its own module, not a part of DigestModule. Mail is household-scoped rather
 * than per child, it needs no model call, it runs on a ten-minute cadence
 * rather than hourly in the afternoon, and the requirement was explicitly a
 * separate message. What it does reuse is deliberate: TelegramSender (and so
 * the chunking and the permanent-failure classification with it), the mail
 * scope helper, and the digest's staleness constant -- two copies of the mail
 * visibility rule is what produced the badge asymmetry `unreadBadge`
 * documents, and two staleness windows would race each other.
 *
 * It reads `digest_recipient` and never writes it, except to disable a row
 * Telegram has refused permanently.
 *
 * Known consequence, accepted: a chat linked for a single child now also
 * receives that household's mail. A per-recipient `mailEnabled` opt-in is the
 * follow-up if that turns out wrong -- deliberately not built now, because a
 * column with no UI toggle behind it is a feature nobody can see.
 */
@Injectable()
export class InboxNotifyService {
  private readonly logger = new Logger(InboxNotifyService.name);

  /** In-process guard, as in DigestService: a slow run must not overlap itself. */
  private running = false;

  private readonly media: MediaDelivery;

  private readonly upstreamMail: UpstreamMail;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(TelegramSender) private readonly telegram: DigestSender,
    // `@Optional()` so this module compiles without the global media module --
    // which is how the module spec proves MashovSessionModule is not in this
    // graph. See telegram-media.module.ts.
    @Optional() @Inject(MEDIA_DELIVERY) media?: MediaDelivery,
    @Optional() @Inject(UPSTREAM_MAIL) upstreamMail?: UpstreamMail,
  ) {
    this.media = media ?? NO_MEDIA_DELIVERY;
    this.upstreamMail = upstreamMail ?? NO_UPSTREAM_MAIL;
  }

  async notifyAll(options: InboxNotifyRunOptions = {}): Promise<InboxNotifyResult[]> {
    if (this.running) {
      this.logger.warn('An inbox notification run is already in flight; skipping this tick.');
      return [];
    }
    this.running = true;

    try {
      const now = options.now ?? new Date();
      const timeZone = this.config.get<string>('DIGEST_TIMEZONE') ?? DEFAULT_TIMEZONE;

      if (!options.ignoreQuietHours && this.isQuiet(now, timeZone)) {
        // Held over, not dropped: the lookback window still covers it when the
        // next run after the window finds it unnotified.
        this.logger.debug('Inside the quiet window; holding any new mail over.');
        return [];
      }

      const dryRun = options.dryRun ?? this.isDryRunByDefault();
      const subscriptions = await this.subscriptions(options.userId);
      if (subscriptions.size === 0) return [];

      const results: InboxNotifyResult[] = [];
      for (const [userId, chats] of subscriptions) {
        // Per run, not per chat: two chats of one parent want the same
        // conversation hydrated once.
        const hydrated = new Set<string>();
        results.push(
          ...(await this.notifyUser(userId, chats, now, timeZone, dryRun, hydrated)),
        );
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  /**
   * The chats to notify, as (parent -> chats), deduped per (channel, address).
   *
   * Deduped because mail is household-scoped: a parent who linked one family
   * group chat for three children has three `digest_recipient` rows and one
   * inbox, and three copies of the same message is what they read as the
   * feature being broken.
   *
   * The floor keeps the EARLIEST `activeFrom` among the deduped rows, matching
   * what the digest does per child. In practice the lookback window dominates
   * it; it matters on the day a chat is first linked.
   */
  private async subscriptions(
    userId?: string,
  ): Promise<Map<string, { channel: string; address: string; activeFrom: Date }[]>> {
    const rows = await this.prisma.digestRecipient.findMany({
      where: { enabled: true, ...(userId ? { userId } : {}) },
      select: { userId: true, channel: true, address: true, activeFrom: true },
    });

    const byUser = new Map<string, Map<string, { channel: string; address: string; activeFrom: Date }>>();
    for (const row of rows) {
      const chats = byUser.get(row.userId) ?? new Map();
      const key = `${row.channel}\u0000${row.address}`;
      const existing = chats.get(key);
      if (!existing || row.activeFrom < existing.activeFrom) {
        chats.set(key, { channel: row.channel, address: row.address, activeFrom: row.activeFrom });
      }
      byUser.set(row.userId, chats);
    }

    return new Map([...byUser].map(([key, chats]) => [key, [...chats.values()]]));
  }

  private async notifyUser(
    userId: string,
    chats: { channel: string; address: string; activeFrom: Date }[],
    now: Date,
    timeZone: string,
    dryRun: boolean,
    hydrated: Set<string>,
  ): Promise<InboxNotifyResult[]> {
    const { reportFor } = jerusalemDayBounds(now, timeZone);
    const lookbackFloor = new Date(now.getTime() - this.readLookbackHours() * 60 * 60 * 1000);
    const results: InboxNotifyResult[] = [];

    for (const chat of chats) {
      // Per chat, because `activeFrom` is per chat: the floor is the later of
      // "since you linked this chat" and "as far back as a run ever looks".
      const floor = chat.activeFrom > lookbackFloor ? chat.activeFrom : lookbackFloor;

      try {
        const candidates = await this.candidatesFor(userId, floor, hydrated);
        const result = await this.notifyChat(userId, chat, candidates, reportFor, now, dryRun);
        if (result) results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Inbox notification failed for ${chat.channel}/${chat.address}: ${message}`,
        );
        results.push({
          userId,
          channel: chat.channel,
          address: chat.address,
          status: 'failed',
          messageCount: 0,
          summarized: false,
          error: message,
        });
      }
    }

    return results;
  }

  /**
   * The mail this parent has not been told about, oldest first.
   *
   * **Stricter than `householdMailScope` on purpose, and this is the one place
   * in the project that deviates from it.** That helper admits
   * `householdConnectionId: null` to every caller, because NULL means
   * "ownership unknown" rather than "nobody's" and hiding those rows would
   * empty the inbox on a deployment that has not re-synced. That trade is
   * right for a list view the parent chose to open, and wrong for outbound
   * egress: two households both match a NULL-stamped row, so a family chat
   * both parents linked receives the same mail twice, and in the worst case a
   * stranger's conversation is pushed into a parent's Telegram -- which is
   * forwardable and permanent in a way a list view is not.
   *
   * So the notifier reads only rows stamped to the parent's own connections.
   * The cost is that a conversation the ownership backfill has not reached is
   * never announced; the parent still sees it in the app, which is the safe
   * direction for a push.
   */
  private async candidatesFor(
    userId: string,
    floor: Date,
    hydrated: Set<string>,
  ): Promise<Candidate[]> {
    const ownConnectionIds = await activeConnectionIdsFor(this.prisma, userId);
    if (ownConnectionIds.length === 0) return [];

    const conversations = await this.prisma.mailConversation.findMany({
      where: {
        householdConnectionId: { in: ownConnectionIds },
        NOT: { labels: { array_contains: ['archived'] } },
        // `sendTime` on a conversation is its newest message's, so a
        // conversation below the floor cannot hold a message above it.
        sendTime: { gte: floor },
      },
      select: {
        conversationId: true,
        householdConnectionId: true,
        locallyReadThroughAt: true,
      },
    });
    if (conversations.length === 0) return [];

    const byConversation = new Map(conversations.map((row) => [row.conversationId, row]));

    const read = () =>
      this.prisma.mailMessage.findMany({
        where: {
          conversationId: { in: [...byConversation.keys()] },
          sendTime: { gte: floor },
        },
        select: MESSAGE_SELECT,
        orderBy: { sendTime: 'asc' },
      });

    let messages = await read();

    // MailInboxTask stores message METADATA ONLY -- the inbox list payload
    // carries no `body` and no `files` at all, and both are written only when
    // a parent opens the thread in the app. So a notification about mail
    // nobody has opened -- which is every mail this feature exists to announce
    // -- would be a header and a subject with nothing under it, and no
    // attachment would ever be forwarded. The detail fetch has to happen
    // before the text is rendered, and it cannot happen here: this module may
    // not reach Mashov. Hence the UPSTREAM_MAIL token.
    const needHydration = [
      ...new Set(
        messages
          .filter((message) => !hasBody(message) && !hydrated.has(message.conversationId))
          .map((message) => message.conversationId),
      ),
    ];

    if (this.upstreamMail.enabled && needHydration.length > 0) {
      for (const conversationId of needHydration) {
        // Marked before the attempt, not after: a conversation whose fetch
        // failed must not be retried once per chat in the same run.
        hydrated.add(conversationId);
        // Guarded here as well as in the implementation. The interface says
        // "never throws" and the real one honours it, but the cost of being
        // wrong is the whole notification rather than just its body -- the
        // parent would not learn mail arrived at all.
        await this.upstreamMail
          .hydrateConversation(conversationId, userId)
          .catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Hydrating conversation ${conversationId} failed: ${reason}`);
          });
      }
      messages = await read();
    }

    return this.toCandidates(messages, byConversation, userId);
  }

  /**
   * Applies the per-message filters and shapes the survivors.
   *
   * Split out of `candidatesFor` only because that function now reads the
   * messages twice -- once to find out what needs hydrating, once after.
   */
  private async toCandidates(
    messages: MessageRow[],
    byConversation: Map<string, ConversationRow>,
    userId: string,
  ): Promise<Candidate[]> {
    // The parent's own upstream identity, per connection. A reply they sent
    // from this app comes back down the next inbox walk as a message in the
    // thread, and notifying them about their own words is noise at best.
    const connections = await this.prisma.householdConnection.findMany({
      where: { userId, active: true },
      select: { id: true, upstreamUserId: true },
    });
    const upstreamById = new Map(connections.map((row) => [row.id, row.upstreamUserId]));

    return messages
      .filter((message) => {
        const conversation = byConversation.get(message.conversationId);
        if (!conversation) return false;

        // The local read override. Mashov documents no markAsRead endpoint, so
        // upstream keeps reporting a conversation unread after the parent read
        // it here; without this they would be pinged about mail they have read.
        const readThrough = conversation.locallyReadThroughAt;
        if (readThrough !== null && readThrough >= message.sendTime) return false;

        const connectionId = message.householdConnectionId ?? conversation.householdConnectionId;
        const upstream = connectionId ? upstreamById.get(connectionId) ?? null : null;
        if (upstream !== null) return message.senderId !== upstream;

        // No upstream id on record -- an unattributed row, or a connection that
        // has not logged in since the column was added. `isNew` is the weaker
        // signal (see mail/unread.ts on why it is not a read-state flag), but
        // it is what distinguishes an arrival from an outgoing reply here.
        return message.isNew === true;
      })
      .map((message) => ({
        messageId: message.messageId,
        conversationId: message.conversationId,
        senderName: message.senderName,
        subject: message.subject,
        bodyHtmlSanitized: message.bodyHtmlSanitized,
        bodyTextPreview: message.bodyTextPreview,
        sendTime: message.sendTime,
        contentHash: mailContentHash(message),
        attachments: this.media.enabled
          ? parseAttachmentList(message.files).map((file) => ({
              kind: 'mail' as const,
              ownerId: message.conversationId,
              itemId: message.messageId,
              fileId: file.fileId,
              fileName: file.fileName,
              // One line, and the subject rather than the body: a caption
              // cannot be chunked, and "which mail is this file from" is the
              // only thing it has to answer. Telegram HTML, escaped here --
              // both the filename and the subject are the school's text.
              // Clamped before composing: a caption cannot be chunked, and
              // truncating the composed HTML would cut an entity in half.
              caption:
                `📎 ${escapeTelegramHtml(clampLine(file.fileName, TELEGRAM_CAPTION_NAME_BUDGET))}` +
                ` · ${escapeTelegramHtml(clampLine(message.subject, TELEGRAM_CAPTION_LABEL_BUDGET))}`,
              captionParseMode: 'HTML' as const,
            }))
          : [],
      }));
  }

  /** Claim, send, confirm or release -- for one chat, independently of the rest. */
  private async notifyChat(
    userId: string,
    chat: { channel: string; address: string },
    candidates: Candidate[],
    reportFor: Date,
    now: Date,
    dryRun: boolean,
  ): Promise<InboxNotifyResult | null> {
    if (candidates.length === 0) return null;

    const publicBaseUrl = resolvePublicBaseUrl(this.config.get<string>('PUBLIC_BASE_URL'));
    const bodyChars = this.readBodyChars();

    const base = {
      userId,
      channel: chat.channel,
      address: chat.address,
      messageCount: candidates.length,
      summarized: false,
    };

    if (dryRun) {
      // Claims nothing, on purpose: a dry run that claimed would leave the
      // first real run with nothing to say. The count is the candidate count
      // because nothing was claimed, and that is what a real run would send.
      const summarize = candidates.length > this.readMaxPerRun();
      this.logger.log(
        `[dry run] ${chat.channel}/${chat.address}: ${candidates.length} new mail message(s).`,
      );
      const preview = summarize
        ? renderInboxSummary(candidates.length, { publicBaseUrl })
        : candidates
            .map((message) => renderInboxMessage(message, { publicBaseUrl }, bodyChars))
            .join('\n\n');
      await this.record(userId, chat, reportFor, 'dry_run', candidates.length, preview);
      return { ...base, status: 'dry_run', summarized: summarize };
    }

    const { runId, ownedHashes } = await this.claim(userId, chat, candidates, reportFor, now);
    if (ownedHashes.length === 0) {
      this.logger.log(
        `Inbox notify ${chat.channel}/${chat.address}: every message is owned by another run or already sent.`,
      );
      return { ...base, status: 'skipped_empty', messageCount: 0 };
    }

    // Everything below counts what this run OWNS, never what it saw. A
    // concurrent run can have claimed some of the candidates, and deciding to
    // summarize -- or telling the parent "6 new messages" -- from the
    // candidate count states a number that is not what went out, and logs
    // messageText that was never sent.
    const ownedSet = new Set(ownedHashes);
    const sendingMessages = candidates.filter((candidate) => ownedSet.has(candidate.contentHash));
    const summarize = sendingMessages.length > this.readMaxPerRun();
    const owned = { ...base, messageCount: sendingMessages.length, summarized: summarize };

    const mediaNotes: string[] = [];
    const sentHashes: string[] = [];
    const sentTexts: string[] = [];

    try {
      if (summarize) {
        // No media under a summary: it stands in for N messages, and uploading
        // every one of their files would defeat the point of summarizing.
        const text = renderInboxSummary(sendingMessages.length, { publicBaseUrl });
        await this.telegram.send(chat.address, text, { parseMode: 'HTML' });
        sentTexts.push(text);
        sentHashes.push(...ownedHashes);
      } else {
        let budget = this.media.budgetBytes();
        for (const message of sendingMessages) {
          // Downloaded BEFORE the text is rendered, because no size is known
          // until the bytes arrive and the text has to name what it is not
          // sending. Then text, then media: the text is the only thing gating
          // this message's ledger row, so it goes out before anything that
          // can fail.
          const fetched = await this.fetchMedia(userId, message, budget);
          budget = fetched.remainingBytes;
          mediaNotes.push(...noteOf(fetched.items));

          const text = renderInboxMessage(
            message,
            { publicBaseUrl, unsentFileNames: unsentNames(fetched.items) },
            bodyChars,
          );
          // The text is Telegram HTML; the sender owns whether it goes out as
          // markup and the strip-and-retry if Telegram will not parse it.
          await this.telegram.send(chat.address, text, { parseMode: 'HTML' });

          // Recorded as sent the moment it is sent, not after the loop. A
          // failure on message 3 of 4 used to release the whole batch, so the
          // next tick re-sent messages 1 and 2 -- every ten minutes, for as
          // long as the failure lasted.
          sentHashes.push(message.contentHash);
          sentTexts.push(text);

          const result = await this.media.send(chat.address, fetched.items);
          mediaNotes.push(...result.notes);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Inbox notify to ${chat.channel}/${chat.address} failed: ${reason}`);

      if (isPermanentTelegramFailure(reason)) {
        // Nowhere left to retry to. Confirming everything rather than
        // releasing the undelivered rows stops the same mail being re-claimed
        // and re-sent on every ten-minute tick.
        await this.retire(userId, chat, reason);
        await this.confirm(userId, chat, runId, ownedHashes, now);
      } else {
        await this.confirmSent(userId, chat, runId, sentHashes, now);
        await this.release(
          userId,
          chat,
          runId,
          ownedHashes.filter((hash) => !sentHashes.includes(hash)),
        );
      }

      await this.record(
        userId,
        chat,
        reportFor,
        sentHashes.length > 0 ? 'sent' : 'failed',
        sentHashes.length,
        sentTexts.length > 0 ? sentTexts.join('\n\n') : undefined,
        [reason, ...mediaNotes].join('; '),
      );
      return { ...owned, status: sentHashes.length > 0 ? 'sent' : 'failed', error: reason };
    }

    await this.confirm(userId, chat, runId, ownedHashes, now);
    // The media notes ride on errorMessage, the way the digest's partial-send
    // notes do: the row says sent, and here is the asterisk.
    await this.record(
      userId,
      chat,
      reportFor,
      'sent',
      sentHashes.length,
      sentTexts.join('\n\n'),
      mediaNotes.length > 0 ? mediaNotes.join('; ') : undefined,
    );
    return { ...owned, status: 'sent' };
  }

  /**
   * This message's attachments, downloaded within the run's byte budget.
   *
   * Never throws -- the media layer turns every failure into a note -- so an
   * unreadable attachment can neither fail nor re-queue the text message.
   */
  private async fetchMedia(
    userId: string,
    message: Candidate,
    remainingBytes: number,
  ): Promise<{ items: FetchedMedia[]; remainingBytes: number }> {
    if (!this.media.enabled || message.attachments.length === 0) {
      return { items: [], remainingBytes };
    }
    return this.media.fetch(userId, message.attachments, remainingBytes);
  }

  /**
   * Claims the candidates and returns the run id plus the hashes it owns.
   *
   * Same protocol as DigestService.claim and for the same reason: a
   * `createMany` count says how many rows were won but never which, and acting
   * on the candidate list instead is how a message gets sent twice. The run id
   * is returned rather than stashed on the service, which is a singleton:
   * confirm and release scope to it, and that scoping is what stops a failing
   * run deleting a claim a concurrent run is holding.
   */
  private async claim(
    userId: string,
    chat: { channel: string; address: string },
    candidates: Candidate[],
    reportFor: Date,
    now: Date,
  ): Promise<{ runId: string; ownedHashes: string[] }> {
    const runId = randomUUID();

    await this.prisma.mailNotifiedMessage.createMany({
      data: candidates.map((candidate) => ({
        userId,
        channel: chat.channel,
        address: chat.address,
        messageId: candidate.messageId,
        conversationId: candidate.conversationId,
        contentHash: candidate.contentHash,
        notifiedFor: reportFor,
        claimedBy: runId,
      })),
      skipDuplicates: true,
    });

    // Takeover, for a row whose run died between claiming and sending. Nothing
    // was delivered in that case, so the message has to come back. A confirmed
    // row is never taken over -- unlike the digest there is no deferral here.
    await this.prisma.mailNotifiedMessage.updateMany({
      where: {
        userId,
        channel: chat.channel,
        address: chat.address,
        contentHash: { in: candidates.map((candidate) => candidate.contentHash) },
        confirmedAt: null,
        claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) },
      },
      data: { claimedBy: runId, claimedAt: now, confirmedAt: null },
    });

    const owned = await this.prisma.mailNotifiedMessage.findMany({
      where: { userId, channel: chat.channel, address: chat.address, claimedBy: runId },
      select: { messageId: true, contentHash: true },
    });

    return { runId, ownedHashes: owned.map((row) => row.contentHash) };
  }

  /**
   * Marks rows delivered. Scoped to `claimedBy` AND to an explicit hash list,
   * so a partial success confirms only what actually arrived.
   */
  private async confirm(
    userId: string,
    chat: { channel: string; address: string },
    runId: string,
    hashes: string[],
    now: Date,
  ): Promise<void> {
    if (hashes.length === 0) return;
    await this.prisma.mailNotifiedMessage.updateMany({
      where: {
        userId,
        channel: chat.channel,
        address: chat.address,
        claimedBy: runId,
        contentHash: { in: hashes },
      },
      data: { confirmedAt: now, claimedBy: null },
    });
  }

  /** Alias at the call site that reads as what it does. */
  private async confirmSent(
    userId: string,
    chat: { channel: string; address: string },
    runId: string,
    hashes: string[],
    now: Date,
  ): Promise<void> {
    return this.confirm(userId, chat, runId, hashes, now);
  }

  private async release(
    userId: string,
    chat: { channel: string; address: string },
    runId: string,
    hashes: string[],
  ): Promise<void> {
    if (hashes.length === 0) return;
    await this.prisma.mailNotifiedMessage.deleteMany({
      where: {
        userId,
        channel: chat.channel,
        address: chat.address,
        claimedBy: runId,
        contentHash: { in: hashes },
      },
    });
  }

  /** Stops notifying a chat Telegram has refused permanently. */
  private async retire(
    userId: string,
    chat: { channel: string; address: string },
    reason: string,
  ): Promise<void> {
    this.logger.warn(
      `Disabling recipient ${chat.channel}/${chat.address} for inbox mail: ${reason}`,
    );
    await this.prisma.digestRecipient.updateMany({
      where: { userId, channel: chat.channel, address: chat.address },
      data: { enabled: false },
    });
  }

  /**
   * One run-log row per chat, and only when something happened.
   *
   * The cron fires 144 times a day. A row per quiet tick per parent would bury
   * the history this table exists to make readable long before the retention
   * sweep reached it -- which is why `candidates.length === 0` returns before
   * this is ever called.
   */
  private async record(
    userId: string,
    chat: { channel: string; address: string },
    reportFor: Date,
    status: InboxNotifyStatus,
    itemCount: number,
    messageText?: string,
    errorMessage?: string,
  ): Promise<void> {
    await this.prisma.digestDelivery.create({
      data: {
        userId,
        // No child to name: the run is scoped to the parent's whole inbox.
        studentGuid: null,
        kind: 'inbox',
        reportFor,
        status,
        itemCount,
        recipientCount: status === 'sent' ? 1 : 0,
        usedLlm: false,
        channel: chat.channel,
        messageText: messageText ?? null,
        errorMessage: errorMessage ?? null,
      },
    });
  }

  private isQuiet(now: Date, timeZone: string): boolean {
    return isWithinQuietHours(
      now,
      timeZone,
      this.config.get<string>('INBOX_NOTIFY_QUIET_FROM') ?? DEFAULT_QUIET_FROM,
      this.config.get<string>('INBOX_NOTIFY_QUIET_TO') ?? DEFAULT_QUIET_TO,
    );
  }

  /** Defaults to true: a first deploy must not message a parent by accident. */
  private isDryRunByDefault(): boolean {
    const raw = this.config.get<string | boolean>('INBOX_NOTIFY_DRY_RUN');
    if (raw === undefined || raw === null || raw === '') return true;
    return String(raw).trim().toLowerCase() !== 'false';
  }

  private readLookbackHours(): number {
    return this.readPositiveInt('INBOX_NOTIFY_LOOKBACK_HOURS', DEFAULT_LOOKBACK_HOURS);
  }

  private readMaxPerRun(): number {
    return this.readPositiveInt('INBOX_NOTIFY_MAX_PER_RUN', DEFAULT_MAX_PER_RUN);
  }

  private readBodyChars(): number {
    return this.readPositiveInt('INBOX_NOTIFY_BODY_CHARS', DEFAULT_BODY_CHARS);
  }

  private readPositiveInt(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string | number>(key));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}

/**
 * sha256 over exactly what the parent will see.
 *
 * In the ledger's unique key, so an edited subject or body yields a new hash,
 * hence a new row, hence a legitimate re-notification -- the same contract as
 * DigestReportedItem.contentHash. Never include a column the sync upserts
 * churn.
 */
export function mailContentHash(message: {
  messageId: string;
  senderName: string;
  subject: string;
  bodyHtmlSanitized: string | null;
  bodyTextPreview: string | null;
  sendTime: Date;
}): string {
  return createHash('sha256')
    .update(
      [
        message.messageId,
        message.senderName,
        message.subject,
        message.bodyHtmlSanitized ?? message.bodyTextPreview ?? '',
        message.sendTime.toISOString(),
      ].join('\u0000'),
    )
    .digest('hex');
}

/** The names the text has to mention because the bytes are not going out. */
function unsentNames(items: FetchedMedia[]): string[] {
  return items.filter((item) => item.tooLarge).map((item) => item.ref.fileName);
}

/** Every reason a file is absent, for the delivery row. */
function noteOf(items: FetchedMedia[]): string[] {
  return items
    .map((item) => item.note)
    .filter((note): note is string => typeof note === 'string' && note.length > 0);
}
