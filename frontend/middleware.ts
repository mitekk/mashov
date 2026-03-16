import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/auth/', '/_next/', '/favicon.ico', '/api/health'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((prefix) => pathname.startsWith(prefix));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get('session');

  if (!sessionCookie) {
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
