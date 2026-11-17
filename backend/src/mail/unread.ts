/**
 * The single definition of "unread" for a mail conversation.
 *
 * ## What the production data showed
 *
 * The badge read 39 where Mashov's own `unreadConversations` read 16. The suspected
 * cause was that `conv.isNew` is a sticky conversation-level flag and that
 * `messages[].isNew` is what really tracks read state. Measured against production,
 * that is **wrong**, and the measurement is worth keeping because the mistake is easy
 * to make twice:
 *
 *   local_unread = 39   genuinely_unread = 0   stale_orphans = 23
 *
 * Every message of all 39 locally-unread conversations came back `isNew: false` --
 * including the 16 that Mashov itself counts as unread. So `messages[].isNew` is not a
 * read-state signal in the inbox *list* payload (it appears to carry real state only
 * on the conversation-detail endpoint), and deriving from it would have set the badge
 * to **0**: the failure direction that hides mail rather than over-reporting it.
 *
 * `conv.isNew` is correct. The 39 was 16 conversations upstream still returns, plus 23
 * rows upstream had stopped returning and nothing ever cleared -- 16 + 23 = 39, and the
 * 16 matches `unreadConversations` exactly. The over-count was never about which flag
 * to read; it was the absence of reconciliation, which `MailInboxTask`'s sweep now does.
 *
 * ## What this function is for
 *
 * Two jobs remain. Read `conv.isNew`, and honour the local read override -- the one
 * thing Mashov cannot tell us, because it documents no `markAsRead` endpoint, so
 * upstream keeps reporting a conversation unread after the user has read it here.
 * `messages[].sendTime` is used for that, and only for that: it is a timestamp rather
 * than a flag, and nothing in the data casts doubt on it.
 */

export interface DerivableMessage {
  sendTime?: string | Date | null;
}

export interface DerivableConversation {
  isNew?: boolean | null;
  messages?: DerivableMessage[] | null;
}

/**
 * Parse a Mashov timestamp, which arrives naive (`"2026-03-09T18:49:43"`) and so is
 * interpreted in the process's zone. That is only safe because both sides of the
 * comparison below are message `sendTime`s that went through this same function --
 * never `Date.now()`, which would sit in a different parsing domain and clear read
 * overrides for any mail read within a few hours of arriving.
 */
function parseSendTime(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * @param conv upstream conversation payload (inbox walk or detail hydration)
 * @param locallyReadThrough the conversation's `locallyReadThroughAt` watermark: the
 *   `sendTime` of the newest message the user had when they marked it read locally, or
 *   `null` if they never did. Without it the next walk restores `isUnread: true` from
 *   an upstream flag that never learned about the user's action, and the badge visibly
 *   bounces back within 7 minutes.
 */
export function deriveIsUnread(
  conv: DerivableConversation,
  locallyReadThrough: Date | null,
): boolean {
  if (conv.isNew !== true) return false;
  if (locallyReadThrough === null) return true;

  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  // Nothing to compare against: honour the user's explicit read rather than an upstream
  // flag that cannot know about it. A payload that carries no messages is the degenerate
  // case; the next walk that returns a full one re-evaluates this.
  if (messages.length === 0) return false;

  // Unread again only if something arrived after the user marked it read. A message whose
  // sendTime cannot be parsed counts as newer: showing mail that may already be read is
  // recoverable, hiding mail is not.
  return messages.some((msg) => {
    const sendTime = parseSendTime(msg.sendTime);
    return sendTime === null || sendTime.getTime() > locallyReadThrough.getTime();
  });
}
