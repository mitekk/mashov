import { deriveIsUnread } from './unread';

const SEND_TIME = '2026-03-18T08:00:00Z';

function msg(overrides: Record<string, unknown> = {}) {
  return { isNew: true, isDeleted: false, sendTime: SEND_TIME, ...overrides };
}

describe('deriveIsUnread', () => {
  describe('message-derived state', () => {
    it('returns false when the only message is read even though the conversation flag is set', () => {
      expect(deriveIsUnread({ isNew: true, messages: [msg({ isNew: false })] }, null)).toBe(false);
    });

    it('returns true when any message is unread', () => {
      expect(
        deriveIsUnread({ isNew: false, messages: [msg({ isNew: false }), msg()] }, null),
      ).toBe(true);
    });

    it('ignores the conversation flag entirely when messages are present', () => {
      expect(deriveIsUnread({ isNew: false, messages: [msg()] }, null)).toBe(true);
      expect(deriveIsUnread({ isNew: true, messages: [msg({ isNew: false })] }, null)).toBe(false);
    });

    it('treats a deleted unread message as read', () => {
      expect(deriveIsUnread({ isNew: true, messages: [msg({ isDeleted: true })] }, null)).toBe(false);
    });

    it('stays unread when one unread message is deleted and another is not', () => {
      expect(
        deriveIsUnread({ isNew: false, messages: [msg({ isDeleted: true }), msg()] }, null),
      ).toBe(true);
    });

    it('does not gate on folder — an unread message outside folder 0 still counts', () => {
      expect(deriveIsUnread({ isNew: false, messages: [msg({ folder: 2 })] }, null)).toBe(true);
    });

    it('tolerates a missing isDeleted field', () => {
      expect(deriveIsUnread({ isNew: false, messages: [{ isNew: true }] }, null)).toBe(true);
    });
  });

  describe('fallback to the conversation flag', () => {
    it('falls back when messages is absent', () => {
      expect(deriveIsUnread({ isNew: true }, null)).toBe(true);
      expect(deriveIsUnread({ isNew: false }, null)).toBe(false);
    });

    it('falls back when messages is an empty array', () => {
      expect(deriveIsUnread({ isNew: true, messages: [] }, null)).toBe(true);
    });

    it('falls back when messages is not an array', () => {
      expect(
        deriveIsUnread({ isNew: true, messages: 'nope' as unknown as [] }, null),
      ).toBe(true);
    });

    it('returns false when neither messages nor the conversation flag is usable', () => {
      expect(deriveIsUnread({}, null)).toBe(false);
    });

    it('applies the local read override to the fallback too', () => {
      expect(deriveIsUnread({ isNew: true }, new Date(SEND_TIME))).toBe(false);
    });
  });

  describe('local read override', () => {
    it('suppresses unread when every unread message is at or before the watermark', () => {
      expect(
        deriveIsUnread({ isNew: true, messages: [msg()] }, new Date(SEND_TIME)),
      ).toBe(false);
    });

    it('re-opens when a message arrived after the watermark', () => {
      expect(
        deriveIsUnread(
          { isNew: true, messages: [msg({ sendTime: '2026-03-18T09:00:00Z' })] },
          new Date(SEND_TIME),
        ),
      ).toBe(true);
    });

    it('re-opens when only one of several unread messages is newer than the watermark', () => {
      expect(
        deriveIsUnread(
          {
            isNew: true,
            messages: [msg(), msg({ sendTime: '2026-03-18T09:00:00Z' })],
          },
          new Date(SEND_TIME),
        ),
      ).toBe(true);
    });

    it('is irrelevant when no message is unread', () => {
      expect(
        deriveIsUnread({ isNew: true, messages: [msg({ isNew: false })] }, new Date('2020-01-01T00:00:00Z')),
      ).toBe(false);
    });

    it('keeps an unread message with an unusable sendTime visible', () => {
      expect(
        deriveIsUnread({ isNew: true, messages: [msg({ sendTime: null })] }, new Date(SEND_TIME)),
      ).toBe(true);
      expect(
        deriveIsUnread({ isNew: true, messages: [msg({ sendTime: 'not-a-date' })] }, new Date(SEND_TIME)),
      ).toBe(true);
    });

    it('accepts a Date sendTime as well as a string', () => {
      expect(
        deriveIsUnread(
          { isNew: true, messages: [msg({ sendTime: new Date('2026-03-18T09:00:00Z') })] },
          new Date(SEND_TIME),
        ),
      ).toBe(true);
    });
  });
});
