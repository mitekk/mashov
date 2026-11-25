'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Inbox, Mail, MailQuestion, TriangleAlert } from 'lucide-react';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAdminFeedbackList } from '@/hooks/useAdminFeedback';
import { cn } from '@/lib/utils';
import type { AdminFeedbackFilter, AdminFeedbackListItem } from '@/types/api';
import { subjectLabel } from './subject';

const FILTERS: { value: AdminFeedbackFilter; label: string; testId: string }[] = [
  { value: 'all', label: 'All', testId: 'admin-feedback-filter-all' },
  { value: 'new', label: 'New', testId: 'admin-feedback-filter-new' },
  { value: 'awaiting', label: 'Awaiting response', testId: 'admin-feedback-filter-awaiting' },
];

/** Unrecognised values fall back to `all` rather than 400ing the list. */
function filterFromParam(param: string | null): AdminFeedbackFilter {
  return param === 'new' || param === 'awaiting' ? param : 'all';
}

function pageFromParam(param: string | null): number {
  const page = Number(param);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/** ISO-8601 UTC in, something an operator can read out. */
function formatStamp(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });
}

function StateChips({ item }: { item: AdminFeedbackListItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {item.readAt === null && (
        <span className="chip border-primary/40 bg-primary/10 text-primary" data-testid={`admin-feedback-chip-new-${item.id}`}>
          New
        </span>
      )}
      {item.hasContactEmail && item.respondedAt === null && (
        <span className="chip" data-testid={`admin-feedback-chip-awaiting-${item.id}`}>
          <MailQuestion className="h-3 w-3" aria-hidden="true" />
          Awaiting response
        </span>
      )}
      {item.respondedAt !== null && (
        <span className="chip" data-testid={`admin-feedback-chip-responded-${item.id}`}>
          Answered
        </span>
      )}
      {item.notifiedAt === null && (
        // Colour is not the only cue: the icon and the word carry it too.
        <span
          className="chip border-destructive/40 bg-destructive/10 text-destructive"
          data-testid={`admin-feedback-chip-undelivered-${item.id}`}
        >
          <TriangleAlert className="h-3 w-3" aria-hidden="true" />
          Not delivered
        </span>
      )}
    </div>
  );
}

function AdminFeedbackContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const filter = filterFromParam(searchParams.get('filter'));
  const page = pageFromParam(searchParams.get('page'));

  const { data, isLoading, isError, refetch } = useAdminFeedbackList(filter, page);

  const items = data?.data ?? [];
  const pagination = data?.pagination;

  // URL state, so a lens is shareable and the back button works. `replace`
  // rather than `push`: flipping a filter is not a navigation an operator
  // wants to walk back through one click at a time.
  const go = (next: { filter?: AdminFeedbackFilter; page?: number }) => {
    const params = new URLSearchParams();
    const nextFilter = next.filter ?? filter;
    const nextPage = next.page ?? (next.filter ? 1 : page);
    if (nextFilter !== 'all') params.set('filter', nextFilter);
    if (nextPage > 1) params.set('page', String(nextPage));
    const query = params.toString();
    router.replace(query ? `/admin/feedback?${query}` : '/admin/feedback');
  };

  return (
    <div dir="ltr" className="page-shell page-shell-wide" data-testid="admin-feedback-page">
      <header className="page-header">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Feedback triage</h1>
          <p className="text-sm text-muted-foreground">
            Parent reports, newest first.
            {pagination ? ` ${pagination.total} in this view.` : ''}
          </p>
        </div>
      </header>

      <nav aria-label="Filter reports" className="flex flex-wrap gap-2 pt-4">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            data-testid={option.testId}
            aria-current={filter === option.value ? 'true' : undefined}
            onClick={() => go({ filter: option.value })}
            className={cn(
              'tap-target rounded-full border px-4 py-1.5 text-sm font-medium transition-colors',
              filter === option.value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        ))}
      </nav>

      <div className="space-y-3 pt-4">
        {isLoading && <LoadingState message="Loading reports..." />}
        {!isLoading && isError && <ErrorState message="Could not load reports." onRetry={() => void refetch()} />}
        {!isLoading && !isError && items.length === 0 && (
          filter === 'all' ? (
            <EmptyState
              icon={<Inbox className="h-10 w-10" />}
              title="No reports yet"
              subtitle="Nothing has been sent through the in-app feedback form."
            />
          ) : (
            // A distinct state from "no reports at all": told the generic copy,
            // an operator concludes the table is empty rather than that they
            // are looking through a filter.
            <div className="space-y-3">
              <EmptyState
                icon={<Mail className="h-10 w-10" />}
                title={filter === 'new' ? 'Nothing unread' : 'Nothing awaiting a response'}
                subtitle="Every report in this lens has been handled."
              />
              <button
                type="button"
                data-testid="admin-feedback-filter-reset"
                onClick={() => go({ filter: 'all' })}
                className="mx-auto block text-sm font-medium text-primary underline underline-offset-4 transition-colors hover:text-primary/80"
              >
                Show all
              </button>
            </div>
          )
        )}

        {!isLoading && !isError && items.length > 0 && (
          <ul className="space-y-3" data-testid="admin-feedback-list">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/admin/feedback/${item.id}`}
                  data-testid={`admin-feedback-row-${item.id}`}
                  className="card-base block p-4 transition-colors hover:bg-accent/50"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-foreground" dir="auto">
                      {subjectLabel(item.subject)}
                      {item.subjectOther ? ` — ${item.subjectOther}` : ''}
                    </span>
                    <time className="text-xs text-muted-foreground" dateTime={item.createdAt}>
                      {formatStamp(item.createdAt)}
                    </time>
                  </div>
                  <p className="pt-1 text-sm text-muted-foreground" dir="auto">
                    {item.displayName} ({item.username})
                    {item.schools.length > 0 ? ` · ${item.schools.join(', ')}` : ''}
                  </p>
                  <div className="pt-2">
                    <StateChips item={item} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {pagination && pagination.totalPages > 1 && (
          <nav
            aria-label="Pagination"
            className="flex items-center justify-between pt-2"
            data-testid="admin-feedback-pagination"
          >
            <button
              type="button"
              data-testid="admin-feedback-prev-page"
              disabled={pagination.page <= 1}
              onClick={() => go({ page: pagination.page - 1 })}
              className="tap-target rounded-full border border-border px-4 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-xs text-muted-foreground">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <button
              type="button"
              data-testid="admin-feedback-next-page"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => go({ page: pagination.page + 1 })}
              className="tap-target rounded-full border border-border px-4 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-40"
            >
              Next
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}

/**
 * Standalone on purpose: no `AppShell`, so no bottom nav, no parent header and
 * no Hebrew `dir="rtl"` wrapper. This screen is not part of the parent app.
 *
 * `useSearchParams` requires a `<Suspense>` boundary in the App Router -- it
 * suspends during prerender, and without one the whole route de-opts to a
 * client-rendered page with a build-time warning. Same pattern and same reason
 * as `InboxPageClient`.
 */
export default function AdminFeedbackPageClient() {
  return (
    <Suspense
      fallback={(
        <div dir="ltr" className="page-shell page-shell-wide" data-testid="admin-feedback-page">
          <LoadingState message="Loading reports..." />
        </div>
      )}
    >
      <AdminFeedbackContent />
    </Suspense>
  );
}
