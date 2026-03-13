import { ChildWorkspacePage } from '@/components/child/ChildWorkspacePage';

interface ChildWorkspacePageProps {
  params: Promise<{ studentGuid: string }>;
}

export default async function ChildWorkspacePageRoute({
  params,
}: ChildWorkspacePageProps) {
  const { studentGuid } = await params;
  return <ChildWorkspacePage studentGuid={studentGuid} />;
}
