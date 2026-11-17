import { type NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL || 'http://backend:3000';

/**
 * Wall-clock bound for a single backend call. Sits comfortably above the
 * backend's own Mashov budget (MASHOV_TIMEOUT_MS, default 10s) and well below
 * Cloudflare's ~100s cutoff, so a stalled dependency surfaces as a real 504
 * from this app instead of a Cloudflare 524 with no error body.
 */
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 15000;

/**
 * `POST /sync/refresh` runs every sync task synchronously before responding, so
 * it legitimately outlives the default bound. It gets its own larger budget —
 * still under Cloudflare's ~100s cutoff, so the failure stays ours to report.
 * Without this, a slow-but-successful refresh returns 504 to the client, the
 * mutation rejects, its query invalidation never runs, and the user is left
 * looking at stale data with the spinner stopped and no error shown.
 */
const SLOW_PATH_TIMEOUT_MS = Number(process.env.PROXY_SLOW_TIMEOUT_MS) || 90000;
const SLOW_PATH_PREFIXES = ['/api/v1/sync/'];

function timeoutForPath(pathname: string): number {
  return SLOW_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ? SLOW_PATH_TIMEOUT_MS
    : PROXY_TIMEOUT_MS;
}

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

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // AbortSignal.timeout() rejects with a TimeoutError; an explicit abort or a
  // nested abort surfaces as AbortError.
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return (
    cause instanceof Error &&
    (cause.name === 'TimeoutError' || cause.name === 'AbortError')
  );
}

/** Standard error envelope — never leak the upstream failure detail. */
function upstreamErrorResponse(error: unknown): NextResponse {
  const [status, code, message] = isTimeoutError(error)
    ? [504, 'GATEWAY_TIMEOUT', 'The server took too long to respond. Please try again.']
    : [502, 'UPSTREAM_ERROR', 'The server is unavailable. Please try again.'];

  return NextResponse.json({ error: { code, message, details: [] } }, { status });
}

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

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: request.method,
      headers,
      body,
      // @ts-expect-error — Node.js fetch supports duplex for streaming request bodies
      duplex: body ? 'half' : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutForPath(pathname)),
    });
  } catch (error) {
    return upstreamErrorResponse(error);
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    responseHeaders.delete(header);
  }
  // Body is re-created below; these are no longer trustworthy from upstream.
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');

  // The abort signal stays armed while the body streams, so this read can also
  // reject — and an unhandled rejection here would surface as an opaque 500.
  let responseBody: ArrayBuffer | null;
  try {
    responseBody = request.method === 'HEAD' ? null : await upstream.arrayBuffer();
  } catch (error) {
    return upstreamErrorResponse(error);
  }

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
