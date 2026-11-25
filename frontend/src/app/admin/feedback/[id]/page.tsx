import type { Metadata } from 'next';
import AdminFeedbackDetailClient from './AdminFeedbackDetailClient';

interface AdminFeedbackDetailRouteProps {
  /** Next 15: route params arrive as a promise. */
  params: Promise<{ id: string }>;
}

export async function generateMetadata(
  _props: AdminFeedbackDetailRouteProps,
): Promise<Metadata> {
  return {
    title: 'Feedback report',
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default function AdminFeedbackDetailRoute() {
  return <AdminFeedbackDetailClient />;
}
