import type { Metadata } from 'next';
import ResetPasswordPageClient from './ResetPasswordPageClient';

export const metadata: Metadata = {
  title: 'סיסמה חדשה | מרכז הורים',
  description: 'הגדרת סיסמת משוב חדשה עם קוד האימות שנשלח',
  alternates: {
    canonical: '/auth/reset-password',
  },
  // Never indexed: the URL carries a single-use recovery handle, and a page
  // that sets a third-party password has no business in a search result.
  robots: {
    index: false,
    follow: false,
  },
};

export default function ResetPasswordPage() {
  return <ResetPasswordPageClient />;
}
