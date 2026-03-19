import type { Metadata } from 'next';
import SyncingPageClient from './SyncingPageClient';

export const metadata: Metadata = {
  title: 'סנכרון',
  robots: {
    index: false,
    follow: false,
  },
};

export default function SyncingPage() {
  return <SyncingPageClient />;
}
