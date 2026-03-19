import type { Metadata } from 'next';
import SignInPageClient from './SignInPageClient';

export const metadata: Metadata = {
  title: 'כניסה',
  alternates: {
    canonical: '/auth/sign-in',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function SignInPage() {
  return <SignInPageClient />;
}
