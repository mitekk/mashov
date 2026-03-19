import type { Metadata } from 'next';
import { ChildWorkspacePage } from '@/components/child/ChildWorkspacePage';

interface ChildWorkspacePageProps {
  params: Promise<{ studentGuid: string }>;
}

export async function generateMetadata(
  _props: ChildWorkspacePageProps,
): Promise<Metadata> {
  return {
    title: 'פרופיל תלמיד',
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default async function ChildWorkspacePageRoute({
  params,
}: ChildWorkspacePageProps) {
  const { studentGuid } = await params;
  return <ChildWorkspacePage studentGuid={studentGuid} />;
}
