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
      <div className="px-4 pt-4">
        <h1 className="text-lg font-bold text-foreground">{safeSubject}</h1>
      </div>

      {/* Messages */}
      <div className="px-4 space-y-3">
        {conversation.messages.map((msg) => (
          <MessageBubble key={msg.messageId} message={msg} />
        ))}
      </div>

      {/* Reply disabled notice */}
      {conversation.preventReply && (
        <div className="mx-4 mb-4 flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg px-4 py-3">
          <MessageCircleOff className="w-4 h-4 flex-shrink-0" />
          <span>השיחה נעולה — לא ניתן להגיב</span>
        </div>
      )}
    </section>
  );
}
