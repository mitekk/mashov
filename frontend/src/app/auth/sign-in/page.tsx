import type { Metadata } from 'next';
import SignInPageClient from './SignInPageClient';

export const metadata: Metadata = {
  title: 'כניסה למרכז הורים',
  description: 'התחברו למרכז הורים — צפו בציונים, שיעורי בית והודעות של ילדכם דרך מערכת משוב',
  alternates: {
    canonical: '/auth/sign-in',
  },
  openGraph: {
    title: 'כניסה | מרכז הורים',
    description: 'התחברו למרכז הורים — צפו בציונים, שיעורי בית והודעות של ילדכם דרך מערכת משוב',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function SignInPage() {
  return <SignInPageClient />;
}
