'use client';

import React, { Suspense, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { ConversationList } from '@/components/inbox/ConversationList';
import { UnreadBadge } from '@/components/inbox/UnreadBadge';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  useArchive,
  useConversations,
  useMailSummary,
  useMarkRead,
  useMarkUnread,
  useUnarchive,
} from '@/hooks/useMail';
import { Archive, Mail, MailOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SchoolFilterChips } from '@/components/school/SchoolFilterChips';
import { useMe } from '@/hooks/useAuth';
import {
  ALL_SCHOOLS,
  parseSchoolFilter,
  serializeSchoolFilter,
  type SchoolFilter,
} from '@/lib/school-filter';

type InboxFilter = 'all' | 'new' | 'archived';

function getFilterFromParam(param: string | null): InboxFilter {
  if (param === null) return 'new';
  if (param === 'new' || param === 'unread') return 'new';
  if (param === 'archived') return 'archived';
  if (param === 'all') return 'all';
  return 'new';
}

function InboxPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeFilter = getFilterFromParam(searchParams.get('filter'));
  const [selectedConversationIds, setSelectedConversationIds] = useState<string[]>([]);

  const { data: summary } = useMailSummary();
  const { data: me, isError: isMeError } = useMe();

  // Both params coexist: /inbox?filter=new&school=540175 is a valid state, and
  // each row of chips owns its own key.
  const schoolFilter = parseSchoolFilter(searchParams.get('school'), me?.schools ?? []);
  const hasSchoolFilter = schoolFilter !== ALL_SCHOOLS;
  // The same condition `SchoolFilterChips` renders on. The caption explains the
  // chips, so it must not outlive them.
  const hasChipRow = (me?.schools.length ?? 0) > 1;
  // The chip and the URL are keyed by semel, while `?schoolId=` wants a
  // `HouseholdConnection.id`. `me.schools` carries both, so the mapping lives
  // here rather than in the query param.
  const schoolConnectionId = me?.schools.find((school) => school.semel === schoolFilter)?.id;
  // A school-scoped deep link waits for `me`: without the gate the first fetch
  // goes out unfiltered and flashes another school's mail before the semel can
  // be resolved to a connection id.
  // `!isMeError` matters: `useMe` has `retry: false`, so a failure that is not
  // a 401 leaves `data` undefined for good. Without it the gate would read
  // "errored" as "still loading" and spin for ever, with no error affordance,
  // because the conversations query that owns `isError` never ran.
  const isAwaitingMe = Boolean(searchParams.get('school'))
    && me === undefined
    && !isMeError;
  const {
    data,
    isLoading,
    isError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useConversations(activeFilter, schoolConnectionId, { enabled: !isAwaitingMe });
  // The gate covers the FIRST paint only. `['me']` refetches whenever a new
  // component observes it -- and the chips mount and unmount with it -- so
  // under a failing `/auth/me` its status flickers between 'error' and
  // 'pending'; a gate that re-closed on that flicker would hide a list that
  // already has its pages.
  const isGatedFirstPaint = isAwaitingMe && data === undefined;
  const { mutate: markRead, isPending: isMarkReadPending } = useMarkRead();
  const { mutate: markUnread, isPending: isMarkUnreadPending } = useMarkUnread();
  const { mutate: archive, isPending: isArchivePending } = useArchive();
  const { mutate: unarchive, isPending: isUnarchivePending } = useUnarchive();

  // The server's own pages, already narrowed to the chip: everything below --
  // the selection, "select all visible", the counts and the load-more -- reads
  // the same list the parent is looking at.
  const conversations = useMemo(
    () => data?.pages.flatMap((page) => page.data) ?? [],
    [data],
  );

  function setSchoolFilter(next: SchoolFilter) {
    // Cleared exactly as `setFilter` clears it: the bulk bar's count reads the
    // raw id array, so a selection carried across a chip change read
    // "נבחרו 2" above an archive button that then acted on one row.
    setSelectedConversationIds([]);
    const params = new URLSearchParams(searchParams.toString());
    const value = serializeSchoolFilter(next);
    if (value === null) params.delete('school');
    else params.set('school', value);
    const query = params.toString();
    router.replace(query ? `/inbox?${query}` : '/inbox');
  }

  const isBulkActionPending = isMarkReadPending
    || isMarkUnreadPending
    || isArchivePending
    || isUnarchivePending;
  const hasSelection = selectedConversationIds.length > 0;
  const selectedConversations = useMemo(
    () => conversations.filter((conversation) => selectedConversationIds.includes(conversation.conversationId)),
    [conversations, selectedConversationIds],
  );
  const selectedArchivedIds = useMemo(
    () => selectedConversations
      .filter((conversation) => conversation.labels.includes('archived'))
      .map((conversation) => conversation.conversationId),
    [selectedConversations],
  );
  const selectedNonArchivedIds = useMemo(
    () => selectedConversations
      .filter((conversation) => !conversation.labels.includes('archived'))
      .map((conversation) => conversation.conversationId),
    [selectedConversations],
  );
  const hasArchivedSelection = selectedArchivedIds.length > 0;
  const hasNonArchivedSelection = selectedNonArchivedIds.length > 0;

  const setFilter = (val: InboxFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('filter', val);
    const nextQuery = params.toString();
    router.replace(nextQuery ? `/inbox?${nextQuery}` : '/inbox');
    setSelectedConversationIds([]);
  };

  const handleToggleSelect = (conversationId: string, checked: boolean) => {
    setSelectedConversationIds((prev) => {
      if (checked) {
        if (prev.includes(conversationId)) return prev;
        return [...prev, conversationId];
      }
      return prev.filter((id) => id !== conversationId);
    });
  };

  const handleSelectAllVisible = () => {
    const visibleIds = conversations.map((conversation) => conversation.conversationId);
    setSelectedConversationIds(visibleIds);
  };

  const handleClearSelection = () => {
    setSelectedConversationIds([]);
  };

  const handleMarkReadSelected = () => {
    if (!hasSelection || isBulkActionPending || selectedNonArchivedIds.length === 0) return;
    markRead(selectedNonArchivedIds, {
      onSuccess: () => {
        setSelectedConversationIds([]);
      },
    });
  };

  const handleMarkUnreadSelected = () => {
    if (!hasSelection || isBulkActionPending || selectedNonArchivedIds.length === 0) return;
    markUnread(selectedNonArchivedIds, {
      onSuccess: () => {
        setSelectedConversationIds([]);
      },
    });
  };

  const handleArchiveSelected = () => {
    if (!hasSelection || isBulkActionPending || selectedNonArchivedIds.length === 0) return;
    archive(selectedNonArchivedIds, {
      onSuccess: () => {
        setSelectedConversationIds([]);
      },
    });
  };

  const handleUnarchiveSelected = () => {
    if (!hasSelection || isBulkActionPending || selectedArchivedIds.length === 0) return;
    unarchive(selectedArchivedIds, {
      onSuccess: () => {
        setSelectedConversationIds([]);
      },
    });
  };

  return (
    <div data-testid="inbox-page" className="page-shell space-y-5">
      {/*
        At 360 this row was a title plus a three-segment filter (~190px) plus
        two 40px buttons, all on one non-wrapping line. The buttons are the app
        header's now, and `.page-header` wraps below sm regardless -- the
        filter group is still ~190px beside a title, and the wrapping is what
        keeps that off one line.
      */}
      <header className="page-header items-center">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="page-title">דואר</h1>
          {summary && summary.newConversations > 0 && (
            <UnreadBadge count={summary.newConversations} />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Filter toggle */}
          <div className="flex overflow-hidden rounded-xl border border-border/80 bg-card text-sm shadow-sm">
            <button
              data-testid="filter-unread"
              onClick={() => setFilter('new')}
              className={cn(
                'px-3 py-1.5 transition-colors',
                activeFilter === 'new'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              לא נקרא
            </button>
            <button
              data-testid="filter-archived"
              onClick={() => setFilter('archived')}
              className={cn(
                'px-3 py-1.5 transition-colors',
                activeFilter === 'archived'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              ארכיון
            </button>
            <button
              data-testid="filter-all"
              onClick={() => setFilter('all')}
              className={cn(
                'px-3 py-1.5 transition-colors',
                activeFilter === 'all'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              הכל
            </button>
          </div>
        </div>
      </header>

      <SchoolFilterChips value={schoolFilter} onChange={setSchoolFilter} />

      {/* T13 finding 2. The nav badge is household-global and must stay that
          way: a parent filtered to one school still needs to know the other
          has mail. So the badge and this list legitimately disagree while a
          filter is on, and nothing said so — a number that contradicts the
          screen beneath it reads as a bug rather than as a scope. Precedent
          for explaining the filter in words is the filtered empty state
          below.

          Gated on `hasChipRow` as well as on the filter: `SchoolFilterChips`
          renders null below two schools while the filter lives in the URL, so a
          parent who unlinks their second school and returns to a bookmarked
          `?school=` would otherwise get a sentence about "every school" above
          one school, with no chip row and nothing to clear. */}
      {hasSchoolFilter && hasChipRow && (
        <p
          data-testid="inbox-badge-scope-note"
          className="px-1 text-xs text-muted-foreground"
        >
          הסימון שליד &quot;דואר&quot; מונה את כל בתי הספר
        </p>
      )}

      {hasSelection && (
        <section
          data-testid="inbox-bulk-actions"
          // `.sticky-under-header` replaces `lg:top-4`: it tracks the app
          // header rather than parking behind it. A `top-*` utility here would
          // win over it -- see globals.css.
          className="card-base sticky-under-header flex flex-wrap items-center gap-2 px-3 py-2.5 lg:sticky lg:z-10"
        >
          <span className="text-sm font-medium text-foreground">
            נבחרו {selectedConversationIds.length}
          </span>
          <button
            type="button"
            data-testid="bulk-select-all-visible"
            onClick={handleSelectAllVisible}
            disabled={isBulkActionPending}
            className="tap-target rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            בחר הכל
          </button>
          {hasArchivedSelection && (
            <button
              type="button"
              data-testid="bulk-unarchive"
              onClick={handleUnarchiveSelected}
              disabled={isBulkActionPending}
              className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <Archive className="h-3.5 w-3.5" />
              שחזר מארכיון
            </button>
          )}
          {hasNonArchivedSelection && (
            <>
              {activeFilter === 'new' ? (
                <button
                  type="button"
                  data-testid="bulk-mark-read"
                  onClick={handleMarkReadSelected}
                  disabled={isBulkActionPending}
                  className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <Mail className="h-3.5 w-3.5" />
                  סמן כנקרא
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="bulk-mark-unread"
                  onClick={handleMarkUnreadSelected}
                  disabled={isBulkActionPending}
                  className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <MailOpen className="h-3.5 w-3.5" />
                  סמן כלא נקרא
                </button>
              )}
              <button
                type="button"
                data-testid="bulk-archive"
                onClick={handleArchiveSelected}
                disabled={isBulkActionPending}
                className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <Archive className="h-3.5 w-3.5" />
                ארכיון
              </button>
            </>
          )}
          <button
            type="button"
            data-testid="bulk-clear-selection"
            onClick={handleClearSelection}
            disabled={isBulkActionPending}
            className="tap-target rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            נקה בחירה
          </button>
        </section>
      )}

      <div className="section-stack measure">
        {/* The gate is part of the condition, not merely of the query: a
            disabled TanStack v5 query reports `isLoading === false`, so
            without it a gated first paint would fall through to the empty
            state. */}
        {(isLoading || isGatedFirstPaint) && <LoadingState message="טוען הודעות..." />}
        {!isGatedFirstPaint && isError && <ErrorState onRetry={() => void refetch()} />}
        {!isLoading && !isGatedFirstPaint && !isError && (
          conversations.length === 0 ? (
            hasSchoolFilter ? (
              // A distinct state from "no mail at all". Told the generic copy,
              // a parent concludes the mailbox is broken rather than that they
              // are looking through a filter.
              <div className="space-y-3">
                <EmptyState
                  icon={<Mail className="w-10 h-10" />}
                  title="אין דואר מבית הספר הזה"
                  subtitle="אפשר להציג את הדואר מכל בתי הספר"
                />
                <button
                  type="button"
                  data-testid="inbox-school-filter-reset-btn"
                  onClick={() => setSchoolFilter(ALL_SCHOOLS)}
                  className="mx-auto block text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80 transition-colors"
                >
                  הצג הכל
                </button>
              </div>
            ) : (
              <EmptyState
                icon={<Mail className="w-10 h-10" />}
                title={
                  activeFilter === 'new'
                    ? 'אין הודעות שלא נקראו'
                    : activeFilter === 'archived'
                      ? 'אין פריטים בארכיון'
                      : 'תיבת הדואר ריקה'
                }
              />
            )
          ) : (
            <ConversationList
              conversations={conversations}
              hasMore={Boolean(hasNextPage)}
              isLoadingMore={isFetchingNextPage}
              onLoadMore={() => {
                void fetchNextPage();
              }}
              selectedConversationIds={selectedConversationIds}
              onToggleSelect={handleToggleSelect}
            />
          )
        )}
      </div>
    </div>
  );
}

export default function InboxPage() {
  return (
    <AppShell>
      <Suspense
        fallback={(
          <div data-testid="inbox-page" className="page-shell">
            <div className="section-stack">
              <LoadingState message="טוען הודעות..." />
            </div>
          </div>
        )}
      >
        <InboxPageContent />
      </Suspense>
    </AppShell>
  );
}

