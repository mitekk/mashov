import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { GoogleAnalytics } from '@next/third-parties/google';
import './globals.css';
import Providers from './providers';

// Assistant is self-hosted from committed woff2 files (src/assets/fonts/, see
// its README and ADR-0042) rather than fetched through `next/font/google`. That
// loader resolves the family over the network *during `next build`* -- inside
// `docker build` -- and twice in four CI runs it failed on an unparseable
// response (`TypeError: Cannot read properties of null (reading '1')`). A build
// must not depend on a third party answering correctly.
//
// ONE CALL PER SUBSET, because `unicode-range` can only be set per *call*:
// Next's postcss-next-font plugin forces every @font-face in one call to the
// first one's family, and `declarations` is call-scoped, not src-scoped. The
// ranges are what keep a Hebrew reader from downloading latin-ext at all. They
// are copied from Google's served CSS; `fetch-assistant.sh` prints them, and
// they must be re-diffed whenever the files are updated.
//
// ALL THREE DECLARE THE SAME `font-family: 'Assistant'`, which is what makes
// this safe and is exactly what the Google loader emitted before. The
// `adjustFontFallback` shim appends an extra unranged
// `@font-face{font-family:'Assistant Fallback';src:local("Arial")}` to the
// variable's value. Unranged means it matches every glyph -- so had each subset
// carried its own family name, chaining `var(--a), var(--b)` would put
// `'A Fallback'` ahead of family B and render all of B's text in size-adjusted
// Arial, silently. With one shared family every real subset sits at position 1
// and the shim can never shadow anything, whatever the order.
//
// THE SHIM IS DERIVED FROM THE LATIN FILE, not the Hebrew one: fontkit's
// `calcAverageWidth` measures a lowercase a-z string and returns `undefined`
// when the font lacks those glyphs, which silently collapses `size-adjust` to
// 100% and computes the ascent/descent overrides against an unadjusted em. The
// Hebrew subset has no a-z, so `adjustFontFallback` there would produce a
// *worse* shim than today's `size-adjust: 92.87%`. Hence it stays on latin and
// is off on the other two -- only one may emit the face in any case.
//
// `weight` is the RANGE '300 700', matching the `font-weight` Google declares
// for these exact files: they are variable fonts, one per subset, each covering
// all five weights the app uses.
//
// The hebrew/latin-ext `variable` names are never read in CSS. They exist so
// that every call's return value is referenced in rendered JSX: the next/font
// webpack rule is registered with `sideEffects: false`, so a call whose object
// goes unused is tree-shaken and its @font-face silently disappears from the
// production bundle while still working in dev. Do not remove them.
const assistantLatin = localFont({
  src: '../assets/fonts/assistant-latin.woff2',
  weight: '300 700',
  style: 'normal',
  display: 'swap',
  preload: true,
  variable: '--font-assistant',
  declarations: [
    { prop: 'font-family', value: 'Assistant' },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});

const assistantHebrew = localFont({
  src: '../assets/fonts/assistant-hebrew.woff2',
  weight: '300 700',
  style: 'normal',
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  variable: '--font-assistant-hebrew-face',
  declarations: [
    { prop: 'font-family', value: 'Assistant' },
    {
      prop: 'unicode-range',
      value: 'U+0307-0308, U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F',
    },
  ],
});

// Not preloaded: the extended Latin ranges appear nowhere in the app's own copy,
// so this file costs a visitor nothing until a glyph actually needs it.
const assistantLatinExt = localFont({
  src: '../assets/fonts/assistant-latin-ext.woff2',
  weight: '300 700',
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  variable: '--font-assistant-latin-ext-face',
  declarations: [
    { prop: 'font-family', value: 'Assistant' },
    {
      prop: 'unicode-range',
      value:
        'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
    },
  ],
});

const fontClasses = [
  assistantLatin.className,
  assistantLatin.variable,
  assistantHebrew.variable,
  assistantLatinExt.variable,
].join(' ');

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

  // The font classes go on <body>, NOT <html>. Two constraints pin this down:
  //
  //  - <html>'s class attribute belongs to the theme. `themeBootstrap` above
  //    toggles `dark` on document.documentElement before hydration; giving
  //    <html> a React `className` prop lets React reconcile that attribute and
  //    wipe the class, which breaks dark mode on reload and navigation.
  //    (`suppressHydrationWarning` silences the warning, not the patching.)
  //  - Custom properties inherit DOWNWARD only, so with the variables on <body>
  //    the `html { font-family: var(--font-assistant) }` rule in globals.css
  //    cannot resolve and is dropped as invalid-at-computed-value-time. That
  //    rule has in fact never applied -- `.className` is what has always put
  //    the font on the page, and still is. Tailwind's `font-sans` utilities
  //    resolve the variable normally, since they match elements inside <body>.
  //
  // `assistantLatin.className` carries `font-family: Assistant` -- the shared
  // family name, so that one class covers all three subsets. The other two
  // `.variable` values are here only so every call's object is referenced; see
  // the tree-shaking note above.
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className={fontClasses}>
        <Providers>{children}</Providers>
        {process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID && (
          <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID} />
        )}
      </body>
    </html>
  );
}
