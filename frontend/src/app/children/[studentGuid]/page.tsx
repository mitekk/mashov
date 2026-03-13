import { redirect } from 'next/navigation';
import { buildChildSectionHref, DEFAULT_CHILD_SECTION } from '@/lib/child-routes';

interface ChildWorkspaceRedirectPageProps {
  params: Promise<{ studentGuid: string }>;
}

export default async function ChildWorkspaceRedirectPage({
  params,
}: ChildWorkspaceRedirectPageProps) {
  const { studentGuid } = await params;
  const targetHref = buildChildSectionHref(studentGuid, DEFAULT_CHILD_SECTION);
  redirect(targetHref ?? '/children');
}
