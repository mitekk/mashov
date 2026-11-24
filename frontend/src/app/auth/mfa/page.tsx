import type { Metadata } from 'next';
import MfaPageClient from './MfaPageClient';

export const metadata: Metadata = {
  title: 'אימות דו-שלבי | מרכז הורים',
  description: 'השלמת כניסה למשוב עם קוד אימות חד-פעמי',
  alternates: {
    canonical: '/auth/mfa',
  },
  // A step in a flow, keyed by a challenge id in the query. Nothing to index.
  robots: {
    index: false,
    follow: false,
  },
};

export default function MfaPage() {
  return <MfaPageClient />;
}
