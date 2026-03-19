import type { Metadata } from 'next';
import { HomeworkDetailPage } from '@/components/child/HomeworkDetailPage';

interface HomeworkDetailRouteProps {
  params: Promise<{ studentGuid: string; homeworkId: string }>;
}

export async function generateMetadata(
  _props: HomeworkDetailRouteProps,
): Promise<Metadata> {
  return {
    title: 'שיעורי בית',
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default async function HomeworkDetailRoute({
  params,
}: HomeworkDetailRouteProps) {
  const { studentGuid, homeworkId } = await params;
  return <HomeworkDetailPage studentGuid={studentGuid} homeworkId={homeworkId} />;
}
