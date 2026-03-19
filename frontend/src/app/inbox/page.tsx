import type { Metadata } from 'next';
import InboxPageClient from './InboxPageClient';

export const metadata: Metadata = {
  title: 'תיבת דואר',
  alternates: {
    canonical: '/inbox',
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function InboxPage() {
  return <InboxPageClient />;
}
