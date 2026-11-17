import { deriveIsUnread } from './unread';

const READ_THROUGH = new Date('2026-03-18T08:00:00Z');

function msg(overrides: Record<string, unknown> = {}) {
  return { sendTime: '2026-03-18T08:00:00Z', ...overrides };
}

describe('deriveIsUnread', () => {
  describe('the conversation flag is the read-state source', () => {
    it('is unread when the conversation flag is set', () => {
      expect(deriveIsUnread({ isNew: true, messages: [msg()] }, null)).toBe(true);
    });

    it('is read when the conversation flag is clear', () => {
      expect(deriveIsUnread({ isNew: false, messages: [msg()] }, null)).toBe(false);
    });

    it('is read when the conversation flag is missing', () => {
      expect(deriveIsUnread({ messages: [msg()] }, null)).toBe(false);
      expect(deriveIsUnread({}, null)).toBe(false);
    });

    it('ignores messages[].isNew, which the inbox list payload reports as false even for conversations Mashov counts as unread', () => {
      expect(deriveIsUnread({ isNew: true, messages: [msg({ isNew: false })] }, null)).toBe(true);
      expect(deriveIsUnread({ isNew: false, messages: [msg({ isNew: true })] }, null)).toBe(false);
    });

    it('does not consult folder', () => {
      expect(deriveIsUnread({ isNew: true, messages: [msg({ folder: 2 })] }, null)).toBe(true);
    });
  });

  describe('local read override', () => {
    it('suppresses unread when no message is newer than the watermark', () => {
      expect(deriveIsUnread({ isNew: true, messages: [msg()] }, READ_THROUGH)).toBe(false);
    });

    it('re-opens when a message arrived after the watermark', () => {
      expect(
        deriveIsUnread(
          { isNew: true, messages: [msg({ sendTime: '2026-03-18T09:00:00Z' })] },
          READ_THROUGH,
        ),
      ).toBe(true);
    });

    it('re-opens when only one of several messages is newer than the watermark', () => {
      expect(
        deriveIsUnread(
          { isNew: true, messages: [msg(), msg({ sendTime: '2026-03-18T09:00:00Z' })] },
          READ_THROUGH,
        ),
      ).toBe(true);
    });

    it('is irrelevant when the conversation flag is already clear', () => {
      expect(
        deriveIsUnread({ isNew: false, messages: [msg({ sendTime: '2026-03-18T09:00:00Z' })] }, READ_THROUGH),
      ).toBe(false);
    });

    it('accepts a Date sendTime as well as a string', () => {
      expect(
        deriveIsUnread(
          { isNew: true, messages: [msg({ sendTime: new Date('2026-03-18T09:00:00Z') })] },
          READ_THROUGH,
        ),
      ).toBe(true);
    });

    it('keeps a message with an unusable sendTime visible', () => {
      expect(deriveIsUnread({ isNew: true, messages: [msg({ sendTime: null })] }, READ_THROUGH)).toBe(true);
      expect(
        deriveIsUnread({ isNew: true, messages: [msg({ sendTime: 'not-a-date' })] }, READ_THROUGH),
      ).toBe(true);
    });

    it('honours the override when the payload carries no messages to compare', () => {
      expect(deriveIsUnread({ isNew: true }, READ_THROUGH)).toBe(false);
      expect(deriveIsUnread({ isNew: true, messages: [] }, READ_THROUGH)).toBe(false);
      expect(
        deriveIsUnread({ isNew: true, messages: 'nope' as unknown as [] }, READ_THROUGH),
      ).toBe(false);
    });

    it('still trusts the conversation flag with no override and no messages', () => {
      expect(deriveIsUnread({ isNew: true }, null)).toBe(true);
      expect(deriveIsUnread({ isNew: true, messages: [] }, null)).toBe(true);
    });
  });
});
