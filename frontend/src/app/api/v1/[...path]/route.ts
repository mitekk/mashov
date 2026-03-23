import { type NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL || 'http://backend:3000';

async function proxy(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const pathname = `/api/v1/${path.join('/')}`;
  const search = request.nextUrl.search;
  const url = `${BACKEND_URL}${pathname}${search}`;

  const headers = new Headers(request.headers);
  headers.delete('host');

  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : request.body;

  const upstream = await fetch(url, {
    method: request.method,
    headers,
    body,
    // @ts-expect-error — Node.js fetch supports duplex for streaming request bodies
    duplex: body ? 'half' : undefined,
    redirect: 'manual',
  });

  const responseHeaders = new Headers(upstream.headers);
  // Remove hop-by-hop headers
  responseHeaders.delete('transfer-encoding');

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
