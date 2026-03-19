import type { Metadata } from 'next';
import ConversationPageClient from './ConversationPageClient';

interface ConversationPageRouteProps {
  params: Promise<{ conversationId: string }>;
}

export async function generateMetadata(
  _props: ConversationPageRouteProps,
): Promise<Metadata> {
  return {
    title: 'שיחה',
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default function ConversationPageRoute() {
  return <ConversationPageClient />;
}
