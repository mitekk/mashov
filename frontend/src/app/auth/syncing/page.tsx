import type { Metadata } from 'next';
import { Suspense } from 'react';
import SyncingPageClient from './SyncingPageClient';

export const metadata: Metadata = {
  title: 'סנכרון',
  robots: {
    index: false,
    follow: false,
  },
};

export default function SyncingPage() {
  // The client reads a search param, which prerendering requires a boundary
  // for. The fallback is deliberately empty: it is visible for a single frame.
  return (
    <Suspense fallback={null}>
      <SyncingPageClient />
    </Suspense>
  );
}
