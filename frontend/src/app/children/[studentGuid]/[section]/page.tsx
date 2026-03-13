import { redirect } from 'next/navigation';
import { ChildWorkspacePage } from '@/components/child/ChildWorkspacePage';
import {
  buildChildSectionHref,
  DEFAULT_CHILD_SECTION,
  isChildSection,
} from '@/lib/child-routes';

interface ChildWorkspaceSectionPageProps {
  params: Promise<{ studentGuid: string; section: string }>;
}

export default async function ChildWorkspaceSectionPage({
  params,
}: ChildWorkspaceSectionPageProps) {
  const { studentGuid, section } = await params;

  if (!isChildSection(section)) {
    const fallbackHref = buildChildSectionHref(studentGuid, DEFAULT_CHILD_SECTION);
    redirect(fallbackHref ?? '/children');
  }

  return (
    <ChildWorkspacePage studentGuid={studentGuid} activeSection={section} />
  );
}
