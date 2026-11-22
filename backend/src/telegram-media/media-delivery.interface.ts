import { TelegramMediaFile } from '../telegram/telegram-media.sender';

/**
 * The capability token the digest and the inbox notifier depend on.
 *
 * An interface token rather than a class, because the implementation imports
 * MailModule and ChildrenModule -- and through them MashovSessionModule, which
 * `DigestModule`'s docblock and ADR-0026 forbid it to pull into its own graph.
 * So the media work lives in its own module and the consumers know only this
 * shape. Injected `@Optional()`: a module compiled on its own (which
 * digest.module.spec.ts does deliberately, to prove the Mashov client is not
 * reachable from it) falls back to the no-op below.
 */
export const MEDIA_DELIVERY = 'MEDIA_DELIVERY';

/** Which downloader can fetch a file, and what it needs to find it. */
export type MediaAttachmentKind = 'mail' | 'homework' | 'behavior';

export interface MediaAttachmentRef {
  kind: MediaAttachmentKind;
  /** `conversationId` for mail; `studentGuid` for homework and behaviour. */
  ownerId: string;
  /** `messageId` for mail; the HomeworkItem/BehaviorItem id otherwise. */
  itemId: string;
  fileId: string;
  fileName: string;
  /** One line, already composed by the caller. Telegram caps it at 1024. */
  caption?: string;
}

/**
 * One enumerated attachment after the download was attempted.
 *
 * `file` present means it is ready to upload. `tooLarge` means the bytes
 * arrived and were over the ceiling, which the caller turns into an "open it
 * on the site" line -- the reason this is two phases rather than one: no size
 * is known anywhere until the file has been downloaded, and the text has to
 * name the file it is not sending.
 */
export interface FetchedMedia {
  ref: MediaAttachmentRef;
  file?: TelegramMediaFile;
  tooLarge?: boolean;
  /** Why it is not being sent. Lands in the delivery row's errorMessage. */
  note?: string;
}

export interface MediaFetchResult {
  items: FetchedMedia[];
  /** Bytes left in this batch's budget, to thread into the next call. */
  remainingBytes: number;
}

export interface MediaSendResult {
  sent: number;
  /** Per-file failures. Never thrown: a bad attachment must not fail the text. */
  notes: string[];
}

export interface MediaDelivery {
  /** False for the no-op binding, so a caller can skip the work entirely. */
  readonly enabled: boolean;

  /** The starting byte budget for one batch of downloads. */
  budgetBytes(): number;

  /**
   * Downloads what it can, within the file-count and byte budgets.
   *
   * Never throws: every failure becomes a `note` on the item it belongs to.
   * The downloads run as `userId`, through the same methods the HTTP routes
   * use, so a file belonging to a child the parent no longer owns still 404s.
   */
  fetch(
    userId: string,
    refs: MediaAttachmentRef[],
    remainingBytes: number,
  ): Promise<MediaFetchResult>;

  /** Uploads what `fetch` produced. Never throws, for the same reason. */
  send(address: string, items: FetchedMedia[]): Promise<MediaSendResult>;
}

/**
 * The binding used when TELEGRAM_MEDIA_ENABLED is false, and the fallback for
 * a module compiled without the global one.
 *
 * It reports `enabled: false` rather than quietly returning empty results, so
 * a caller can skip enumerating attachments at all instead of paying for the
 * reads and then discarding them.
 */
export const NO_MEDIA_DELIVERY: MediaDelivery = {
  enabled: false,
  budgetBytes: () => 0,
  fetch: async (_userId, refs) => ({
    items: refs.map((ref) => ({ ref, note: 'media delivery is disabled' })),
    remainingBytes: 0,
  }),
  send: async () => ({ sent: 0, notes: [] }),
};

/**
 * Fetching a mail conversation's detail from Mashov.
 *
 * A second token in the same module, and for the same boundary reason as
 * MEDIA_DELIVERY: the notifier must not be able to reach
 * `MashovSessionModule`, because ADR-0023's egress hop is a residential
 * tinyproxy meant only for Mashov and `HTTPS_PROXY` is process-wide.
 *
 * It exists because `MailInboxTask` stores message METADATA ONLY --
 * `apis/get-api-mail-inbox-conversations.md` shows the inbox list payload
 * carries no `body` and no `files` at all, and both are written only when a
 * parent opens the thread in the app. Without this, every notification about
 * mail nobody has opened -- which is every mail the feature exists to
 * announce -- is a header, a sender, a subject and nothing else, and no
 * attachment is ever forwarded.
 */
export const UPSTREAM_MAIL = 'UPSTREAM_MAIL';

export interface UpstreamMail {
  /** False for the no-op binding, so a caller can skip the work entirely. */
  readonly enabled: boolean;

  /**
   * Fetches and persists a conversation's bodies and attachment metadata, as
   * `userId`. Never throws: upstream being down must not cost the parent the
   * notification, only its body.
   */
  hydrateConversation(conversationId: string, userId: string): Promise<void>;
}

/** Used when media is disabled, and when a module is compiled on its own. */
export const NO_UPSTREAM_MAIL: UpstreamMail = {
  enabled: false,
  hydrateConversation: async () => undefined,
};
