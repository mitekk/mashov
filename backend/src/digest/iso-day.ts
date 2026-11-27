/**
 * The digest's one reading of a `YYYY-MM-DD` day.
 *
 * Three places needed it -- the deferral ledger (`digest.service`), the
 * submission summary (`digest-report.template`) and the summarizer's
 * validation of what the model returned -- and they each had their own copy.
 * Two of them built the date with `new Date('…T00:00:00Z')` and one with
 * `Date.UTC`, which looks like a difference and is not: **both roll a day that
 * does not exist silently forward**, so `2026-02-30` became 02/03 everywhere.
 *
 * It is rejected here instead. A model that answered with a day that is not a
 * day has answered nothing, and the alternative is a deadline nobody wrote:
 * ADR-0027's promise is about where a date came from, and "March 2nd, because
 * February has 28 days" is not a provenance a parent can be told.
 */
export function parseIsoDay(raw: string | null | undefined): Date | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;

  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;

  // The round-trip is the whole point: a rolled-over date no longer carries
  // the month and day it was written with.
  const [, year, month, day] = match;
  if (parsed.getUTCFullYear() !== Number(year)) return null;
  if (parsed.getUTCMonth() + 1 !== Number(month)) return null;
  if (parsed.getUTCDate() !== Number(day)) return null;

  return parsed;
}

/** Whether `raw` names a real calendar day. */
export function isIsoDay(raw: string | null | undefined): boolean {
  return parseIsoDay(raw) !== null;
}
