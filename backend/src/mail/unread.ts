/**
 * The single definition of "unread" for a mail conversation.
 *
 * Mashov exposes two read-state flags and they do not agree. The
 * conversation-level `isNew` is sticky: `apis/get-api-mail-inbox-conversations.md`
 * captures a conversation flagged `isNew: true` whose only message is
 * `isNew: false`, which is impossible under the documented meaning ("whether the
 * conversation has unread messages"). Storing that flag as `isUnread` is what made
 * the local unread count read more than twice Mashov's own `unreadConversations`,
 * and because the inbox list's `new` filter shares the predicate, it inflated the
 * list as well.
 *
 * `messages[].isNew` is the flag that actually tracks read state, so it is the one
 * we derive from. A conversation is unread iff it holds at least one message that
 * is unread and not deleted — the same rule `unreadConversations` appears to apply,
 * and therefore the number the parent sees in the Mashov UI they compare against.
 *
 * Note deliberately absent from the rule: `folder`. The detail sample in
 * `apis/get-api-mail-conversations-conversationId.md` has a live conversation whose
 * message sits in `folder: 2`, so folder is not a reliable inbox marker. Archived
 * conversations are excluded by their label at the call site, not here.
 */

export interface DerivableMessage {
  isNew?: boolean | null;
  isDeleted?: boolean | null;
  sendTime?: string | Date | null;
}

export interface DerivableConversation {
  isNew?: boolean | null;
  messages?: DerivableMessage[] | null;
}

/**
 * Parse a Mashov timestamp, which arrives naive (`"2026-03-09T18:49:43"`) and so is
 * interpreted in the process's zone. That is only safe because both sides of the
 * comparison below are message `sendTime`s that went through this same function —
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
 *   `sendTime` of the newest message the user had when they marked it read locally,
 *   or `null` if they never did. Mashov documents no `markAsRead` endpoint, so
 *   without this the next walk would restore `isUnread: true` and the badge would
 *   visibly bounce back within 7 minutes of the user acting.
 */
export function deriveIsUnread(
  conv: DerivableConversation,
  locallyReadThrough: Date | null,
): boolean {
  const messages = Array.isArray(conv.messages) ? conv.messages : null;

  // Degenerate payload: keep today's behaviour rather than silently zeroing the
  // badge if the upstream shape ever changes. The local override still wins — the
  // user's explicit "I read this" outranks a flag we already know to be unreliable.
  if (!messages || messages.length === 0) {
    if (locallyReadThrough !== null) return false;
    return conv.isNew ?? false;
  }

  const unread = messages.filter((msg) => msg.isNew === true && msg.isDeleted !== true);
  if (unread.length === 0) return false;
  if (locallyReadThrough === null) return true;

  // Unread only if something arrived after the user marked the conversation read. A
  // message whose sendTime we cannot parse is treated as newer: showing mail that
  // may already be read is recoverable, hiding mail is not.
  return unread.some((msg) => {
    const sendTime = parseSendTime(msg.sendTime);
    return sendTime === null || sendTime.getTime() > locallyReadThrough.getTime();
  });
}
