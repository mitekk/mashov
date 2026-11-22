import type { Metadata } from 'next';
import TelegramSetupPageClient from './TelegramSetupPageClient';

export const metadata: Metadata = {
  title: 'עדכונים בטלגרם',
  alternates: {
    canonical: '/more/telegram',
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function TelegramSetupPage() {
  return <TelegramSetupPageClient />;
}
