'use client';

import React, { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { ConversationList } from '@/components/inbox/ConversationList';
import { UnreadBadge } from '@/components/inbox/UnreadBadge';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useConversations, useMailSummary } from '@/hooks/useMail';
import { Mail } from 'lucide-react';
import { cn } from '@/lib/utils';

function InboxPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const unreadOnly = searchParams.get('filter') === 'unread';
  const [page, setPage] = useState(1);

  const { data: summary } = useMailSummary();
  const { data, isLoading, isError, refetch } = useConversations(page, unreadOnly);

  const setFilter = (val: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    if (val) params.set('filter', 'unread');
    else params.delete('filter');
    router.replace(`/inbox?${params.toString()}`);
    setPage(1);
  };

  return (
    <div data-testid="inbox-page" className="page-shell space-y-5">
      <header className="page-header items-center">
        <div className="flex items-center gap-2">
          <h1 className="page-title">דואר</h1>
          {summary && summary.unreadConversations > 0 && (
            <UnreadBadge count={summary.unreadConversations} />
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

      <div className="section-stack">
        {isLoading && <LoadingState message="טוען הודעות..." />}
        {isError && <ErrorState onRetry={() => void refetch()} />}
        {!isLoading && !isError && data && (
          data.data.length === 0 ? (
            <EmptyState
              icon={<Mail className="w-10 h-10" />}
              title={unreadOnly ? 'אין הודעות שלא נקראו' : 'תיבת הדואר ריקה'}
            />
          ) : (
            <ConversationList
              conversations={data.data}
              pagination={data.pagination}
              onLoadMore={() => setPage((p) => p + 1)}
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
