'use client';

import React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowRight, BookmarkCheck, BookmarkX } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { MessageThread } from '@/components/conversation/MessageThread';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useConversation, useMarkConversationHandled } from '@/hooks/useConversation';

export default function ConversationPage() {
  const params = useParams();
  const router = useRouter();
  const conversationId = params.conversationId as string;

  const { data, isLoading, isError, refetch } = useConversation(conversationId);
  const { mutate: markHandled, isPending } = useMarkConversationHandled();

  const handleToggleHandled = () => {
    if (!data) return;
    markHandled({
      itemType: 'mail_conversation',
      itemId: conversationId,
      isRead: true,
      isHandled: !data.isHandled,
    });
  };

  return (
    <AppShell>
      <div data-testid="conversation-page" className="page-shell space-y-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-2 pt-5">
          <button
            onClick={() => router.back()}
            aria-label="חזור"
            className="icon-button"
          >
            <ArrowRight className="h-5 w-5" />
          </button>

          <div className="flex items-center gap-2">
            {data && (
              <button
                data-testid={`mark-handled-${conversationId}`}
                onClick={handleToggleHandled}
                disabled={isPending}
                aria-label={data.isHandled ? 'בטל טיפול' : 'סמן כטופל'}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/85 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {data.isHandled ? (
                  <>
                    <BookmarkX className="h-4 w-4" />
                    <span>בטל טיפול</span>
                  </>
                ) : (
                  <>
                    <BookmarkCheck className="h-4 w-4" />
                    <span>סמן כטופל</span>
                  </>
                )}
              </button>
            )}
            <ThemeToggle />
          </div>
        </div>

        {isLoading && <LoadingState message="טוען שיחה..." />}
        {isError && <ErrorState onRetry={() => void refetch()} />}
        {data && <MessageThread conversation={data} />}
      </div>
    </AppShell>
  );
}
