import type { Metadata, Viewport } from 'next';
import { Assistant } from 'next/font/google';
import './globals.css';
import Providers from './providers';

const assistant = Assistant({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'מרכז הורים',
  description: 'מרכז פיקוד הורים — ממשק מאוחד לנתוני בית הספר',
  manifest: '/manifest.json',
  icons: {
    icon: '/favicon.ico',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#1d4ed8',
};

interface RootLayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <body className={assistant.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
