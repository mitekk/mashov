'use client';

import React, { useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Archive, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { MessageThread } from '@/components/conversation/MessageThread';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { RefreshButton } from '@/components/ui/RefreshButton';
import {
  useArchiveConversation,
  useConversation,
  useMarkConversationNew,
  useMarkConversationRead,
  useUnarchiveConversation,
} from '@/hooks/useConversation';

export default function ConversationPage() {
  const params = useParams();
  const router = useRouter();
  const conversationId = params.conversationId as string;

  const { data, isLoading, isError, refetch } = useConversation(conversationId);
  const { mutate: markNew, isPending: isMarkNewPending } = useMarkConversationNew();
  const { mutate: markRead } = useMarkConversationRead();
  const { mutate: archive, isPending: isArchivePending } = useArchiveConversation();
  const { mutate: unarchive, isPending: isUnarchivePending } = useUnarchiveConversation();
  const autoMarkedReadConversationId = useRef<string | null>(null);
  const isArchived = data?.labels.includes('archived') ?? false;
  const isActionPending = isMarkNewPending || isArchivePending || isUnarchivePending;

  useEffect(() => {
    if (!data) return;
    if (data.labels.includes('archived')) return;
    if (autoMarkedReadConversationId.current === conversationId) return;
    autoMarkedReadConversationId.current = conversationId;
    markRead(conversationId);
  }, [conversationId, data, markRead]);

  const handleToggleNew = () => {
    if (!data) return;
    markNew({ conversationId, isNew: !data.isNew });
  };

  const handleUnarchive = () => {
    unarchive(conversationId);
  };

  const handleArchive = () => {
    archive(conversationId);
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
              <>
                {!isArchived && (
                  <>
                    <button
                      data-testid={`mark-new-${conversationId}`}
                      onClick={handleToggleNew}
                      disabled={isActionPending}
                      aria-label={data.isNew ? 'סמן כנקרא' : 'סמן כלא נקרא'}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/85 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                    >
                      {data.isNew ? (
                        <>
                          <Eye className="h-4 w-4" />
                          <span>סמן כנקרא</span>
                        </>
                      ) : (
                        <>
                          <EyeOff className="h-4 w-4" />
                          <span>סמן כלא נקרא</span>
                        </>
                      )}
                    </button>
                    <button
                      data-testid={`archive-${conversationId}`}
                      onClick={handleArchive}
                      disabled={isActionPending}
                      aria-label="העבר לארכיון"
                      className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/85 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                    >
                      <Archive className="h-4 w-4" />
                      <span>ארכיון</span>
                    </button>
                  </>
                )}
                {isArchived && (
                  <button
                    data-testid={`unarchive-${conversationId}`}
                    onClick={handleUnarchive}
                    disabled={isActionPending}
                    aria-label="שחזר מארכיון"
                    className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/85 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <Archive className="h-4 w-4" />
                    <span>שחזר מארכיון</span>
                  </button>
                )}
              </>
            )}
            <ThemeToggle />
            <RefreshButton />
          </div>
        </div>

        {isLoading && <LoadingState message="טוען שיחה..." />}
        {isError && <ErrorState onRetry={() => void refetch()} />}
        {data && <MessageThread conversation={data} />}
      </div>
    </AppShell>
  );
}
