'use client';

import React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowRight, BookmarkCheck, BookmarkX } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { MessageThread } from '@/components/conversation/MessageThread';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
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
      <div data-testid="conversation-page" className="pb-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 pt-4 mb-2">
          <button
            onClick={() => router.back()}
            aria-label="חזור"
            className="p-2 -ms-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <ArrowRight className="w-5 h-5" />
          </button>

          {data && (
            <button
              data-testid={`mark-handled-${conversationId}`}
              onClick={handleToggleHandled}
              disabled={isPending}
              aria-label={data.isHandled ? 'בטל טיפול' : 'סמן כטופל'}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              {data.isHandled ? (
                <>
                  <BookmarkX className="w-4 h-4" />
                  <span>בטל טיפול</span>
                </>
              ) : (
                <>
                  <BookmarkCheck className="w-4 h-4" />
                  <span>סמן כטופל</span>
                </>
              )}
            </button>
          )}
        </div>

        {isLoading && <LoadingState message="טוען שיחה..." />}
        {isError && <ErrorState onRetry={() => void refetch()} />}
        {data && <MessageThread conversation={data} />}
      </div>
    </AppShell>
  );
}
