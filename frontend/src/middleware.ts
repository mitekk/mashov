import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// The matcher below also catches /api/v1/*, so the backend's @Public() auth
// endpoints must be listed here or sign-in would be redirected instead of
// proxied.
const PUBLIC_PATHS = ['/auth/', '/api/v1/auth/', '/_next/', '/api/health'];

// Crawler and static-asset paths. These must answer with their real content to
// an anonymous request: redirecting /robots.txt or /sitemap.xml to an HTML
// sign-in page makes both unparseable to crawlers, and redirecting the favicon
// stops it rendering on the sign-in page itself.
const PUBLIC_FILES = [
  '/robots.txt',
  '/sitemap.xml',
  '/favicon.ico',
  '/favicon.svg',
  '/manifest.json',
];

function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_FILES.includes(pathname) ||
    PUBLIC_PATHS.some((prefix) => pathname.startsWith(prefix))
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const e2eBypassEnabled = process.env.ENABLE_E2E_AUTH_BYPASS === '1';
  const e2eBypassHeader = request.headers.get('x-mashov-e2e-auth-bypass');
  const e2eBypassAgent =
    request.headers.get('user-agent')?.includes('mashov-e2e-browser') ?? false;
  if (e2eBypassEnabled && (e2eBypassHeader === '1' || e2eBypassAgent)) {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get('mashov_session');

  if (!sessionCookie) {
    // API calls must fail with a status the client can act on. Redirecting them
    // would hand the fetch an HTML sign-in page with a 200.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        {
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
            details: [],
          },
        },
        { status: 401 },
      );
    }

    const signInUrl = new URL('/auth/sign-in', request.url);
    signInUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json).*)',
  ],
};
