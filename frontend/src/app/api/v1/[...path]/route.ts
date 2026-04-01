import { type NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL || 'http://backend:3000';
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

async function proxy(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const pathname = `/api/v1/${path.join('/')}`;
  const search = request.nextUrl.search;
  const url = `${BACKEND_URL}${pathname}${search}`;

  const headers = new Headers(request.headers);
  headers.delete('host');
  // Avoid compressed upstream payloads that can break when re-streamed by the route handler.
  headers.set('accept-encoding', 'identity');

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
  for (const header of HOP_BY_HOP_HEADERS) {
    responseHeaders.delete(header);
  }
  // Body is re-created below; these are no longer trustworthy from upstream.
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');

  const responseBody = request.method === 'HEAD' ? null : await upstream.arrayBuffer();

  return new NextResponse(responseBody, {
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
