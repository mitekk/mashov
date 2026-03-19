import type { Metadata } from 'next';
import { BehaviorDetailPage } from '@/components/child/BehaviorDetailPage';

interface BehaviorDetailRouteProps {
  params: Promise<{ studentGuid: string; behaviorId: string }>;
}

export async function generateMetadata(
  _props: BehaviorDetailRouteProps,
): Promise<Metadata> {
  return {
    title: 'התנהגות',
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default async function BehaviorDetailRoute({
  params,
}: BehaviorDetailRouteProps) {
  const { studentGuid, behaviorId } = await params;
  return <BehaviorDetailPage studentGuid={studentGuid} behaviorId={behaviorId} />;
}
