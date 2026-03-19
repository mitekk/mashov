import type { Metadata } from 'next';
import ChildrenPageClient from './ChildrenPageClient';

export const metadata: Metadata = {
  title: 'ילדים',
  alternates: {
    canonical: '/children',
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function ChildrenPage() {
  return <ChildrenPageClient />;
}
