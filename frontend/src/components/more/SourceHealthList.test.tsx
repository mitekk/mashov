import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SourceHealth } from '@/types/api';
import { SourceHealthList } from './SourceHealthList';

const ONE_WEEK_MINUTES = 7 * 24 * 60;

/** What an unrecognised backend message is summarised to. */
const GENERIC_ERROR = 'הסנכרון נכשל';

/**
 * Every `sync_run.source` base name in `SOURCE_POLICY`, hardcoded.
 *
 * Deliberately a copy rather than an import: the frontend cannot reach
 * `backend/src/sync/source-policy.ts`, and six of these ids once rendered as
 * raw English on `/more` because the label table had silently fallen behind.
 * A new source added there fails this test until it is named in Hebrew.
 */
const POLICY_SOURCES = [
  'students',
  'homework',
  'behavior',
  'mail_inbox',
  'mail_counts',
  'achvas',
  'releases',
  'schoolActivities',
  'grades',
  'message_board',
  'timetable',
  'bells',
  'groups',
  'lessons_count',
  'user_details',
  'daily_behave',
  'out_behave',
] as const;

function entry(overrides: Partial<SourceHealth> & Pick<SourceHealth, 'source'>): SourceHealth {
  return {
    status: 'fresh',
    lastSuccessAt: '2026-11-21T10:00:00Z',
    lastAttemptAt: '2026-11-21T10:00:00Z',
    lastErrorMessage: null,
    fetchedCount: null,
    staleThresholdMinutes: ONE_WEEK_MINUTES,
    ...overrides,
  };
}

/**
 * The list starts folded, so every row assertion needs this first -- the rows
 * are not merely hidden, they are not mounted.
 */
const expand = () => {
  fireEvent.click(screen.getByTestId('source-health-toggle'));
};

/** The red error line under a row, if the row rendered one. */
function errorTexts(): string[] {
  return Array.from(document.querySelectorAll('.text-destructive'))
    .map((node) => node.textContent ?? '')
    .filter((text) => text.length > 0 && text !== 'שגיאה');
}

describe('SourceHealthList', () => {
  // The green-check-plus-red-error row seen on /more. `normalizeSources`
  // folded the per-student entries from `{...entries[0]}`, so entries[0]'s
  // `lastErrorMessage` rode through the reduce unconditionally — the
  // `status === 'failed'` guard only ever applied to *incoming* entries. A
  // departed child's row was entries[0]: fresh on a 7-day threshold, with an
  // error nothing had superseded.
  it('drops the error when the merged status is fresh', () => {
    render(
      <SourceHealthList
        sources={[
          entry({ source: 'groups:departed-guid', lastErrorMessage: 'every connection failed' }),
          entry({ source: 'groups:live-guid' }),
        ]}
      />,
    );
    expand();

    // Twice: once in the header summary, once on the row.
    expect(screen.getAllByText('תקין')).toHaveLength(2);
    expect(errorTexts()).toEqual([]);
  });

  it('shows the error of a failing entry merged with a fresh one', () => {
    render(
      <SourceHealthList
        sources={[
          entry({ source: 'groups:live-guid' }),
          entry({
            source: 'groups:broken-guid',
            status: 'failed',
            lastSuccessAt: null,
            lastErrorMessage: 'upstream 500',
          }),
        ]}
      />,
    );

    expand();

    expect(screen.getAllByText('שגיאה')).toHaveLength(2);
    expect(errorTexts()).toEqual([GENERIC_ERROR]);
  });

  // Not suppressed on `status !== 'failed'`: a stale-but-failing source is the
  // row most worth reading, which is the rule `freshness.service.ts` states
  // for the bare key.
  it('keeps the error on a stale row', () => {
    render(
      <SourceHealthList
        sources={[
          entry({
            source: 'homework:live-guid',
            status: 'stale',
            lastErrorMessage: 'timed out',
          }),
        ]}
      />,
    );

    expand();

    expect(screen.getAllByText('ישן')).toHaveLength(2);
    expect(errorTexts()).toEqual([GENERIC_ERROR]);
  });

  it('picks the error from the worst-status entry that has one', () => {
    render(
      <SourceHealthList
        sources={[
          entry({ source: 'homework:a', status: 'stale', lastErrorMessage: 'stale error' }),
          entry({
            source: 'homework:b',
            status: 'failed',
            lastSuccessAt: null,
            lastErrorMessage: 'failed error',
          }),
        ]}
      />,
    );

    expand();

    // Both entries map to the same summary, so the title attribute is what
    // says WHICH run it came from.
    expect(errorTexts()).toEqual([GENERIC_ERROR]);
    expect(
      document.querySelector('.text-destructive.truncate')?.getAttribute('title'),
    ).toBe('failed error');
  });

  it('names every source in SOURCE_POLICY in Hebrew', () => {
    render(
      <SourceHealthList sources={POLICY_SOURCES.map((source) => entry({ source }))} />,
    );
    expand();

    for (const source of POLICY_SOURCES) {
      // The fallback renders the raw id, so finding the id on screen IS the
      // failure this asserts against.
      expect(screen.queryByText(source)).toBeNull();
    }
    // The six that were missing, by their expected wording.
    expect(screen.getByText('אישורי יציאה')).toBeTruthy();
    expect(screen.getByText('פעילויות בית הספר')).toBeTruthy();
    expect(screen.getByText('מערכת שעות')).toBeTruthy();
    expect(screen.getByText('לוח זמנים')).toBeTruthy();
    expect(screen.getByText('נוכחות יומית')).toBeTruthy();
    expect(screen.getByText('יציאות מהשיעור')).toBeTruthy();
  });

  it('spins a row named in syncingSources and says מסנכרן', () => {
    render(
      <SourceHealthList
        sources={[entry({ source: 'message_board' }), entry({ source: 'grades' })]}
        syncingSources={new Set(['message_board'])}
      />,
    );

    expand();

    expect(screen.getByTestId('source-syncing-message_board')).toBeTruthy();
    expect(screen.queryByTestId('source-syncing-grades')).toBeNull();
    expect(screen.getByText('מסנכרן…')).toBeTruthy();
    // The other row still reports its own status, as does the header.
    expect(screen.getAllByText('תקין')).toHaveLength(2);
  });

  it('suppresses the error line while a row is syncing', () => {
    render(
      <SourceHealthList
        sources={[
          entry({
            source: 'message_board',
            status: 'stale',
            lastErrorMessage: 'every connection failed for abc (tried 2): 403',
          }),
        ]}
        syncingSources={new Set(['message_board'])}
      />,
    );
    expand();

    expect(errorTexts()).toEqual([]);
  });

  // The row reported on /more: a leaked studentGuid plus `(tried 2)`, clipped
  // from the visually-wrong end because an LTR run inside this RTL document is
  // bidi-reordered before `truncate` gets to it.
  it('summarises the every-connection-failed template and hides the guid', () => {
    render(
      <SourceHealthList
        sources={[
          entry({
            source: 'message_board',
            status: 'stale',
            lastErrorMessage:
              'every connection failed for 1a2b3c4d-dead-beef-0000-999999999999 (tried 2): 403 Forbidden; 404 Not Found',
          }),
        ]}
      />,
    );

    expand();

    expect(errorTexts()).toEqual(['לא ניתן היה לגשת לנתוני התלמיד']);
    expect(document.body.textContent).not.toContain('1a2b3c4d-dead-beef-0000-999999999999');
    expect(document.body.textContent).not.toContain('tried 2');
    // Still reachable for debugging.
    expect(
      document.querySelector('.text-destructive.truncate')?.getAttribute('title'),
    ).toContain('1a2b3c4d-dead-beef-0000-999999999999');
  });

  describe('folded header', () => {
    it('mounts no rows until the header is expanded', () => {
      render(<SourceHealthList sources={[entry({ source: 'grades' })]} />);

      expect(screen.queryByText('ציונים')).toBeNull();
      expand();
      expect(screen.getByText('ציונים')).toBeTruthy();
    });

    it('flips aria-expanded on the toggle', () => {
      render(<SourceHealthList sources={[entry({ source: 'grades' })]} />);

      const toggle = screen.getByTestId('source-health-toggle');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('summarises an all-fresh list as תקין plus the source count', () => {
      render(
        <SourceHealthList
          sources={[
            entry({ source: 'grades' }),
            entry({ source: 'homework' }),
            entry({ source: 'bells' }),
          ]}
        />,
      );

      const summary = screen.getByTestId('source-health-summary');
      expect(summary.textContent).toContain('תקין');
      expect(summary.textContent).toContain('3 מקורות');
      expect(screen.getByTestId('source-health-list').getAttribute('data-status')).toBe('fresh');
    });

    // The worst status wins, and the count says how many sources are not fresh
    // -- a single failure must not be summarised as `ישן` just because a stale
    // source happens to sort first.
    it('summarises the worst status and how many sources carry a problem', () => {
      render(
        <SourceHealthList
          sources={[
            entry({ source: 'grades' }),
            entry({ source: 'homework', status: 'stale' }),
            entry({ source: 'bells', status: 'failed', lastSuccessAt: null }),
          ]}
        />,
      );

      const summary = screen.getByTestId('source-health-summary');
      expect(summary.textContent).toContain('שגיאה');
      expect(summary.textContent).not.toContain('ישן');
      expect(summary.textContent).toContain('2 מתוך 3');
      expect(screen.getByTestId('source-health-list').getAttribute('data-status')).toBe('failed');
    });

    it('keeps the header with 0 מקורות when there are no sources', () => {
      render(<SourceHealthList sources={[]} />);

      expect(screen.getByTestId('source-health-summary').textContent).toContain('0 מקורות');
    });

    // The statuses on screen describe the run BEFORE the one in flight, so the
    // summary is replaced rather than sat next to a spinner.
    it('replaces the summary with מסנכרן while a refresh is in flight', () => {
      render(
        <SourceHealthList
          sources={[entry({ source: 'grades', status: 'failed', lastSuccessAt: null })]}
          isSyncing
        />,
      );

      const summary = screen.getByTestId('source-health-summary');
      expect(summary.textContent).toContain('מסנכרן…');
      expect(summary.textContent).not.toContain('שגיאה');
    });

    it('calls onSync from the header without expanding the list', () => {
      const onSync = vi.fn();
      render(<SourceHealthList sources={[entry({ source: 'grades' })]} onSync={onSync} />);

      fireEvent.click(screen.getByTestId('source-health-sync-btn'));

      expect(onSync).toHaveBeenCalledTimes(1);
      // The click must not bubble into the toggle.
      expect(screen.getByTestId('source-health-toggle').getAttribute('aria-expanded')).toBe(
        'false',
      );
    });

    it('disables the sync button while a refresh is in flight', () => {
      render(
        <SourceHealthList
          sources={[entry({ source: 'grades' })]}
          onSync={() => {}}
          isSyncing
        />,
      );

      expect(screen.getByTestId<HTMLButtonElement>('source-health-sync-btn').disabled).toBe(true);
    });

    it('renders no sync button when onSync is not provided', () => {
      render(<SourceHealthList sources={[entry({ source: 'grades' })]} />);

      expect(screen.queryByTestId('source-health-sync-btn')).toBeNull();
    });
  });
});
