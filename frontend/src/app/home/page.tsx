import type { Metadata } from 'next';
import HomePageClient from './HomePageClient';

export const metadata: Metadata = {
  title: 'דף הבית',
  alternates: {
    canonical: '/home',
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function HomePage() {
  return <HomePageClient />;
}
