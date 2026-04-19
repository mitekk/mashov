import type { Metadata, Viewport } from 'next';
import { Assistant } from 'next/font/google';
import { GoogleAnalytics } from '@next/third-parties/google';
import './globals.css';
import Providers from './providers';

const assistant = Assistant({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-assistant',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_BASE_URL ?? 'https://mashov.mitya.dev'),
  title: {
    default: 'מרכז הורים',
    template: '%s | מרכז הורים',
  },
  description: 'ממשק מאוחד לנתוני בית הספר — ציונים, שיעורי בית, ומסרים',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '32x32' },
    ],
  },
  openGraph: {
    type: 'website',
    locale: 'he_IL',
    siteName: 'מרכז הורים',
    title: 'מרכז הורים',
    description: 'ממשק מאוחד לנתוני בית הספר',
  },
  twitter: {
    card: 'summary',
    title: 'מרכז הורים',
    description: 'ממשק מאוחד לנתוני בית הספר',
  },
  alternates: {
    canonical: '/',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#4f85bb',
};

interface RootLayoutProps {
  children: React.ReactNode;
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'מרכז הורים',
  url: process.env.NEXT_PUBLIC_BASE_URL ?? 'https://mashov.mitya.dev',
  description: 'ממשק מאוחד לנתוני בית הספר — ציונים, שיעורי בית, ומסרים',
  inLanguage: 'he',
  applicationCategory: 'EducationApplication',
  operatingSystem: 'All',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'ILS',
  },
};

export default function RootLayout({ children }: RootLayoutProps) {
  const themeBootstrap = `
    (() => {
      try {
        const key = 'mashov.theme';
        const root = document.documentElement;
        const stored = localStorage.getItem(key);
        const isValid = stored === 'light' || stored === 'dark';
        const theme = isValid
          ? stored
          : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        root.classList.toggle('dark', theme === 'dark');
        root.style.colorScheme = theme;
      } catch {}
    })();
  `;

  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className={`${assistant.className} ${assistant.variable}`}>
        <Providers>{children}</Providers>
        {process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID && (
          <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID} />
        )}
      </body>
    </html>
  );
}
