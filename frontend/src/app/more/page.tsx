import type { Metadata } from 'next';
import MorePageClient from './MorePageClient';

export const metadata: Metadata = {
  title: 'הגדרות',
  alternates: {
    canonical: '/more',
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function MorePage() {
  return <MorePageClient />;
}
