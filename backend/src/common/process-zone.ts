/**
 * The process timezone is load-bearing for mail read state.
 *
 * Mashov sends naive timestamps (`"2026-03-09T18:49:43"`). Every ingest site parses
 * them with a bare `new Date(...)`, so they land in whatever zone the process is in,
 * and Prisma then stores the resulting absolute instant -- including the
 * `locallyReadThroughAt` watermark that `deriveIsUnread` compares freshly parsed
 * `sendTime`s against (see `src/mail/unread.ts`).
 *
 * The comparison is only sound while both sides share one parsing domain. Change the
 * zone and the watermarks already in the database stay where they are while new
 * `sendTime`s shift by the offset: east of UTC they parse *earlier*, a watermark sits
 * ahead of genuinely newer mail, and that mail silently stops showing as unread --
 * the failure direction `unread.ts` calls unrecoverable.
 *
 * `backend/Dockerfile` pins `ENV TZ=UTC`, but a compose `environment:` block can
 * override it without anyone noticing, so the invariant is also checked at boot.
 */
export function assertUtcProcessZone(now: Date = new Date()): void {
  const offset = now.getTimezoneOffset();
  if (offset === 0) return;

  throw new Error(
    `Refusing to start: the process timezone is not UTC (getTimezoneOffset() === ${offset}, ` +
      `TZ=${process.env.TZ ?? '<unset>'}). Mashov sends naive timestamps, so a non-UTC zone ` +
      'makes the stored locallyReadThroughAt watermarks incomparable with freshly parsed ' +
      'sendTimes: a watermark then sits ahead of genuinely newer mail and that mail silently ' +
      'stops showing as unread. See src/mail/unread.ts. Set TZ=UTC.',
  );
}
