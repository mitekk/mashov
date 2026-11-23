import type { Metadata } from 'next';
import CompleteSetupPageClient from './CompleteSetupPageClient';

export const metadata: Metadata = {
  title: 'השלמת הגדרת החשבון | מרכז הורים',
  description: 'החלפת סיסמת משוב או הגדרת שם משתמש, לפי דרישת משוב',
  alternates: {
    canonical: '/auth/complete-setup',
  },
  // A step in a flow, keyed by query parameters. Nothing to index.
  robots: {
    index: false,
    follow: false,
  },
};

export default function CompleteSetupPage() {
  return <CompleteSetupPageClient />;
}
