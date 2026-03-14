'use client';

import React, { Suspense, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { ConversationList } from '@/components/inbox/ConversationList';
import { UnreadBadge } from '@/components/inbox/UnreadBadge';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useArchive, useConversations, useMailSummary, useMarkUnread } from '@/hooks/useMail';
import { Archive, Mail, MailOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

function InboxPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const unreadOnly = searchParams.get('filter') === 'unread';
  const [selectedConversationIds, setSelectedConversationIds] = useState<string[]>([]);

  const { data: summary } = useMailSummary();
  const {
    data,
    isLoading,
    isError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useConversations(unreadOnly);
  const { mutate: markUnread, isPending: isMarkUnreadPending } = useMarkUnread();
  const { mutate: archive, isPending: isArchivePending } = useArchive();

  const conversations = useMemo(
    () => data?.pages.flatMap((page) => page.data) ?? [],
    [data],
  );
  const isBulkActionPending = isMarkUnreadPending || isArchivePending;
  const hasSelection = selectedConversationIds.length > 0;

  const setFilter = (val: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    if (val) params.set('filter', 'unread');
    else params.delete('filter');
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

  const handleMarkUnreadSelected = () => {
    if (!hasSelection || isBulkActionPending) return;
    markUnread(selectedConversationIds, {
      onSuccess: () => {
        setSelectedConversationIds([]);
      },
    });
  };

  const handleArchiveSelected = () => {
    if (!hasSelection || isBulkActionPending) return;
    archive(selectedConversationIds, {
      onSuccess: () => {
        setSelectedConversationIds([]);
      },
    });
  };

  return (
    <div data-testid="inbox-page" className="page-shell space-y-5">
      <header className="page-header items-center">
        <div className="flex items-center gap-2">
          <h1 className="page-title">דואר</h1>
          {summary && summary.newConversations > 0 && (
            <UnreadBadge count={summary.newConversations} />
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Filter toggle */}
          <div className="flex overflow-hidden rounded-xl border border-border/80 bg-card text-sm shadow-sm">
            <button
              data-testid="filter-all"
              onClick={() => setFilter(false)}
              className={cn(
                'px-3 py-1.5 transition-colors',
                !unreadOnly
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              הכל
            </button>
            <button
              data-testid="filter-unread"
              onClick={() => setFilter(true)}
              className={cn(
                'px-3 py-1.5 transition-colors',
                unreadOnly
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              לא נקראו
            </button>
          </div>
          <ThemeToggle />
        </div>
      </header>

      {hasSelection && (
        <section
          data-testid="inbox-bulk-actions"
          className="card-base flex flex-wrap items-center gap-2 px-3 py-2.5"
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

      <div className="section-stack">
        {isLoading && <LoadingState message="טוען הודעות..." />}
        {isError && <ErrorState onRetry={() => void refetch()} />}
        {!isLoading && !isError && (
          conversations.length === 0 ? (
            <EmptyState
              icon={<Mail className="w-10 h-10" />}
              title={unreadOnly ? 'אין הודעות שלא נקראו' : 'תיבת הדואר ריקה'}
            />
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
