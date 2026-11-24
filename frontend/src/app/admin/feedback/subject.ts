import { FEEDBACK_SUBJECT_LABELS } from '@/components/feedback/FeedbackDialog';
import type { FeedbackSubject } from '@/types/api';

/**
 * The Hebrew label a parent actually picked, with the raw code beside it.
 *
 * This page is English, and the subject is the one field that must not be:
 * the parent chose "נתון שגוי או חסר" from a Hebrew select, and a report
 * should be read in the words they saw. The code travels along so the value
 * can be matched against `FEEDBACK_SUBJECTS` and used in SQL.
 *
 * A code the label map does not know renders as the bare code rather than
 * blank -- the union is duplicated across two tsconfig roots, and a subject
 * added on the server before the client knows it must still be readable.
 */
export function subjectLabel(subject: string): string {
  const label = FEEDBACK_SUBJECT_LABELS[subject as FeedbackSubject];
  return label ? `${label} (${subject})` : subject;
}
