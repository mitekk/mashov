import { BehaviorDetailPage } from '@/components/child/BehaviorDetailPage';

interface BehaviorDetailRouteProps {
  params: Promise<{ studentGuid: string; behaviorId: string }>;
}

export default async function BehaviorDetailRoute({
  params,
}: BehaviorDetailRouteProps) {
  const { studentGuid, behaviorId } = await params;
  return <BehaviorDetailPage studentGuid={studentGuid} behaviorId={behaviorId} />;
}
