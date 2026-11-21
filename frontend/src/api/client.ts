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

function handle401Redirect(): void {
  if (typeof window !== 'undefined') {
    const event = new CustomEvent('mashov:session-expired');
    window.dispatchEvent(event);
    window.location.href = '/auth/sign-in';
  }
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
    credentials: 'include',
    ...options,
  });

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
