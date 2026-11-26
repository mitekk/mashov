import { apiFetch } from './client';
import type {
  AdminFeedbackDetailResponse,
  AdminFeedbackFilter,
  AdminFeedbackListResponse,
} from '@/types/api';

/**
 * The operator triage endpoints.
 *
 * One file per resource, like `api/mail.ts`. It goes through `apiFetch` for
 * `credentials: 'include'`, which is what carries the `CF_Authorization`
 * cookie Cloudflare Access sets -- without it the browser would be bounced to
 * the Access login on every call.
 *
 * Note these routes answer **403**, never 401, when the Access JWT is missing
 * or invalid. That is deliberate: `apiFetch` turns a 401 into a hard redirect
 * to the PARENT sign-in page, which would look like a broken admin screen.
 * A 403 surfaces as an ordinary `ApiError` the page renders.
 *
 * Every call here opts into `reauthenticateOnRedirect`. When the 24h Access
 * session expires, Access answers these requests with a 302 to its own login
 * host rather than reaching the backend at all; a plain `fetch` follows that
 * cross-origin hop and the browser reports an unreadable CORS error. The
 * option makes the redirect readable and hands the browser to Access as a
 * document navigation, which is the only kind of request that can complete
 * the login.
 */
export function fetchAdminFeedback(
  filter: AdminFeedbackFilter = 'all',
  page = 1,
  limit = 20,
): Promise<AdminFeedbackListResponse> {
  const params = new URLSearchParams({
    filter,
    page: String(page),
    limit: String(limit),
  });
  return apiFetch<AdminFeedbackListResponse>(
    `/admin/feedback?${params.toString()}`,
    { reauthenticateOnRedirect: true },
  );
}

/** Opening the detail is what stamps `readAt` server-side. */
export function fetchAdminFeedbackDetail(id: string): Promise<AdminFeedbackDetailResponse> {
  return apiFetch<AdminFeedbackDetailResponse>(
    `/admin/feedback/${encodeURIComponent(id)}`,
    { reauthenticateOnRedirect: true },
  );
}

export function markAdminFeedbackResponded(
  id: string,
): Promise<AdminFeedbackDetailResponse> {
  return apiFetch<AdminFeedbackDetailResponse>(
    `/admin/feedback/${encodeURIComponent(id)}/response`,
    { method: 'POST', reauthenticateOnRedirect: true },
  );
}
