import type { Metadata } from 'next';
import ForgotPasswordPageClient from './ForgotPasswordPageClient';

export const metadata: Metadata = {
  title: 'שכחתי סיסמה | מרכז הורים',
  description: 'איפוס סיסמת משוב מתוך מרכז הורים, בלי לצאת מהאפליקציה',
  alternates: {
    canonical: '/auth/forgot-password',
  },
  // Not indexed: it is a step in a flow, not a page anyone should land on from
  // a search result, and indexing it would surface a password-reset form for
  // a third-party system under our domain.
  robots: {
    index: false,
    follow: false,
  },
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordPageClient />;
}
