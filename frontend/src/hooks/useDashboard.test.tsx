import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let resolveSync: (() => void) | null = null;
const triggerSyncRefresh = vi.fn(
  () =>
    new Promise<void>((resolve) => {
      resolveSync = resolve;
    }),
);

vi.mock('@/api/sync', () => ({ triggerSyncRefresh: () => triggerSyncRefresh() }));
vi.mock('@/api/dashboard', () => ({ fetchDashboard: vi.fn() }));

const { useSyncRefresh } = await import('./useDashboard');

/**
 * Two independent consumers, which is exactly how the app mounts them: the
 * header renders the inline `RefreshButton` and the overflow menu's sync item
 * at the same time, at every width, with Tailwind hiding one.
 */
const capture: Record<string, ReturnType<typeof useSyncRefresh> | undefined> = {};

function Consumer({ label }: { label: string }) {
  const sync = useSyncRefresh();
  capture[label] = sync;
  return (
    <button type="button" data-testid={label} disabled={sync.isPending} onClick={() => sync.mutate()}>
      {sync.isPending ? 'pending' : 'idle'}
    </button>
  );
}

function renderBoth() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Consumer label="inline" />
      <Consumer label="menu" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  resolveSync = null;
  triggerSyncRefresh.mockClear();
});

describe('useSyncRefresh', () => {
  /**
   * A household sync is one fact, not one per button. Without a shared
   * mutation key each `useMutation` keeps its own `isPending`: a parent fires
   * a sync from the phone's overflow menu, rotates past `sm`, and the inline
   * button reads idle and enabled while the sync is still running -- so a
   * second concurrent sync is one tap away.
   */
  it('reports the same pending state to every consumer', async () => {
    renderBoth();

    expect(screen.getByTestId('inline').textContent).toBe('idle');
    expect(screen.getByTestId('menu').textContent).toBe('idle');

    act(() => {
      screen.getByTestId('menu').click();
    });

    // Both, not just the one that fired it.
    await waitFor(() => {
      expect(screen.getByTestId('menu').textContent).toBe('pending');
      expect(screen.getByTestId('inline').textContent).toBe('pending');
    });
    expect(screen.getByTestId('inline')).toHaveProperty('disabled', true);
  });

  /**
   * `{ ...mutation, isPending: shared }` would leave `status`, `isIdle` and
   * the rest describing only the local instance, so a consumer writing the
   * equivalent-looking `status === 'pending'` or `!isIdle` would quietly get
   * the un-shared answer and bring the double-sync back. The surface is narrow
   * on purpose: what is not exposed cannot disagree.
   */
  it('exposes no second, un-shared way to ask whether a sync is running', async () => {
    renderBoth();

    act(() => {
      screen.getByTestId('menu').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('inline').textContent).toBe('pending');
    });

    expect(Object.keys(capture.inline ?? {}).sort()).toEqual([
      'error',
      'isError',
      'isPending',
      'mutate',
      'mutateAsync',
      'reset',
    ]);
  });

  it('keeps a stable identity so it is safe in a dependency array', () => {
    renderBoth();
    const first = capture.inline;

    act(() => {
      screen.getByTestId('menu').click();
    });

    // Re-rendered, but only the pending flag changed -- not the object every
    // consumer's effects depend on.
    expect(capture.inline?.mutate).toBe(first?.mutate);
  });

  it('clears for every consumer once the sync finishes', async () => {
    renderBoth();

    act(() => {
      screen.getByTestId('menu').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('inline').textContent).toBe('pending');
    });

    await act(async () => {
      resolveSync?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId('inline').textContent).toBe('idle');
      expect(screen.getByTestId('menu').textContent).toBe('idle');
    });
  });

  it('does not fire a second sync while one is in flight', async () => {
    renderBoth();

    act(() => {
      screen.getByTestId('menu').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('inline').textContent).toBe('pending');
    });

    // The disabled attribute is what actually stops the second tap.
    act(() => {
      screen.getByTestId('inline').click();
    });

    expect(triggerSyncRefresh).toHaveBeenCalledTimes(1);
  });
});
