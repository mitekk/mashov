const API_BASE =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_URL ?? '/api/v1')
    : (process.env.NEXT_PUBLIC_API_URL ?? '/api/v1');

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiFetchOptions extends RequestInit {
  /**
   * Opt in to handing the browser over to Cloudflare Access when it answers
   * with a redirect instead of data. Off by default: parent-facing calls are
   * never behind Access, and letting `fetch` follow redirects is what they
   * want.
   */
  reauthenticateOnRedirect?: boolean;
}

function handle401Redirect(): void {
  if (typeof window !== 'undefined') {
    const event = new CustomEvent('mashov:session-expired');
    window.dispatchEvent(event);
    window.location.href = '/auth/sign-in';
  }
}

// Deliberately NOT handle401Redirect: the Access session expiring has nothing
// to do with the parent session, and bouncing the operator to the parent
// sign-in page would lose the admin screen. It is the same reason the admin
// routes answer 403 rather than 401 (see api/adminFeedback.ts).
function handleAccessReauth(): void {
  if (typeof window !== 'undefined') {
    // Only a document request can run the Access login — an XHR cannot follow
    // the 302 (the login page is cross-origin and sends no CORS headers, so
    // the browser reports it as a CORS failure). Reloading hands the browser
    // to Access, which signs the operator in and returns them to this page.
    window.location.reload();
  }
}

export async function apiFetch<T>(
  path: string,
  options?: ApiFetchOptions,
): Promise<T> {
  const { reauthenticateOnRedirect = false, ...init } = options ?? {};
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    credentials: 'include',
    ...init,
    ...(reauthenticateOnRedirect
      ? { redirect: 'manual' as RequestRedirect }
      : {}),
  });

  // With `redirect: 'manual'` an Access redirect arrives as a readable
  // sentinel instead of a CORS error: an opaque response with status 0.
  if (
    reauthenticateOnRedirect &&
    (res.type === 'opaqueredirect' || res.status === 0)
  ) {
    handleAccessReauth();
    throw new ApiError(0, 'Re-authenticating with Cloudflare Access', null);
  }

  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    // A 401 normally means the session is gone, so the handler below throws
    // the browser at sign-in. But POST /school-links answers 401 when the
    // SCHOOL's password is wrong, and bouncing there would throw the parent
    // out of the app and lose the form rather than show them the message.
    // The two are distinguishable by code: the session guard always answers
    // UNAUTHORIZED, the Mashov credential validator always answers
    // INVALID_CREDENTIALS.
    const code = (body as { error?: { code?: string } })?.error?.code;
    if (code !== 'INVALID_CREDENTIALS') {
      handle401Redirect();
    }
    const message =
      (body as { error?: { message?: string } })?.error?.message ??
      'Unauthorized';
    throw new ApiError(res.status, message, body);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message =
      (body as { error?: { message?: string } })?.error?.message ??
      'Request failed';
    throw new ApiError(res.status, message, body);
  }

  // 202 / 204 may have no body
  if (res.status === 202 || res.status === 204) {
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  return res.json() as Promise<T>;
}
