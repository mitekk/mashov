import React from 'react';
import { MessageCircleOff } from 'lucide-react';
import type { ConversationDetail } from '@/types/api';
import { MessageBubble } from './MessageBubble';

interface MessageThreadProps {
  conversation: ConversationDetail;
}

export function MessageThread({ conversation }: MessageThreadProps) {
  const safeSubject =
    typeof conversation.subject === 'string' && conversation.subject.trim().length > 0
      ? conversation.subject
      : 'ללא נושא';

  return (
    <section data-testid="message-thread" className="space-y-3">
      {/* Subject */}
      <div className="pt-2">
        <h1 className="text-xl font-semibold text-foreground">{safeSubject}</h1>
      </div>

      {/* Messages */}
      <div className="space-y-3">
        {conversation.messages.map((msg) => (
          <MessageBubble key={msg.messageId} message={msg} />
        ))}
      </div>

      {/* Reply disabled notice */}
      {conversation.preventReply && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-muted/70 px-4 py-3 text-sm text-muted-foreground">
          <MessageCircleOff className="w-4 h-4 flex-shrink-0" />
          <span>השיחה נעולה — לא ניתן להגיב</span>
        </div>
      )}
    </section>
  );
}
