import { HomeworkDetailPage } from '@/components/child/HomeworkDetailPage';

interface HomeworkDetailRouteProps {
  params: Promise<{ studentGuid: string; homeworkId: string }>;
}

export default async function HomeworkDetailRoute({
  params,
}: HomeworkDetailRouteProps) {
  const { studentGuid, homeworkId } = await params;
  return <HomeworkDetailPage studentGuid={studentGuid} homeworkId={homeworkId} />;
}
