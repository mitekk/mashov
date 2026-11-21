import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SourceHealth } from '@/types/api';
import { SourceHealthList } from './SourceHealthList';

const ONE_WEEK_MINUTES = 7 * 24 * 60;

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

    expect(screen.getByText('תקין')).toBeTruthy();
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

    expect(screen.getByText('שגיאה')).toBeTruthy();
    expect(errorTexts()).toEqual(['upstream 500']);
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

    expect(screen.getByText('ישן')).toBeTruthy();
    expect(errorTexts()).toEqual(['timed out']);
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

    expect(errorTexts()).toEqual(['failed error']);
  });
});
