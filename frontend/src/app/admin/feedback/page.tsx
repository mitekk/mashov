import type { Metadata } from 'next';
import AdminFeedbackPageClient from './AdminFeedbackPageClient';

/**
 * Operator-only. Not in `lib/phase1-routes.ts` and not in `NAV_ITEMS`
 * deliberately: nothing parent-facing links here, and keeping it out of the
 * route allowlist is the belt-and-braces that stops a future in-app link from
 * rendering. See ADR-0045.
 */
export const metadata: Metadata = {
  title: 'Feedback triage',
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminFeedbackPage() {
  return <AdminFeedbackPageClient />;
}
