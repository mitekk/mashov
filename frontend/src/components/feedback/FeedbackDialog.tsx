'use client';

import React, { useEffect, useMemo, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import { useSubmitFeedback } from '@/hooks/useFeedback';
import { useProfile } from '@/hooks/useSettings';
import type { CreateFeedbackBody, FeedbackSubject } from '@/types/api';

/**
 * The subject a parent picks, in their language.
 *
 * Typed `Record<FeedbackSubject, string>` on purpose: a subject added to the
 * union without a label here fails `tsc` rather than rendering an empty
 * option. The codes themselves are the server's -- see
 * `backend/src/feedback/feedback.service.ts`.
 */
export const FEEDBACK_SUBJECT_LABELS: Record<FeedbackSubject, string> = {
  bug: 'תקלה',
  suggestion: 'הצעה לשיפור',
  data: 'נתון שגוי או חסר',
  account: 'התחברות וחשבון',
  notifications: 'טלגרם והתראות',
  timetable: 'מערכת שעות',
  other: 'אחר',
};

/** Keeps the picker's order the agreed one rather than object-key order. */
const SUBJECT_ORDER: FeedbackSubject[] = [
  'bug',
  'suggestion',
  'data',
  'account',
  'notifications',
  'timetable',
  'other',
];

export const FEEDBACK_CONTENT_MAX = 2000;
const SUBJECT_OTHER_MAX = 80;
const EMAIL_MAX = 254;

/** Deliberately loose: the server's `@IsEmail` is the authority. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const schema = z
  .object({
    subject: z.enum(['bug', 'suggestion', 'data', 'account', 'notifications', 'timetable', 'other']),
    subjectOther: z.string().trim().max(SUBJECT_OTHER_MAX, `עד ${SUBJECT_OTHER_MAX} תווים`),
    contactEmail: z
      .string()
      .trim()
      .max(EMAIL_MAX, 'הכתובת ארוכה מדי')
      .refine((value) => value === '' || EMAIL_SHAPE.test(value), {
        message: 'כתובת האימייל אינה תקינה',
      }),
    content: z
      .string()
      .trim()
      .min(1, 'נא לכתוב מה קרה')
      .max(FEEDBACK_CONTENT_MAX, `עד ${FEEDBACK_CONTENT_MAX} תווים`),
  })
  .superRefine((values, ctx) => {
    if (values.subject === 'other' && values.subjectOther.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subjectOther'],
        message: 'נא לפרט את הנושא',
      });
    }
  });

type FeedbackForm = z.infer<typeof schema>;

const FIELD_CLASS =
  'w-full rounded-xl border border-input bg-card px-3 py-2 text-sm text-foreground shadow-[0_8px_24px_-18px_hsl(var(--foreground)/0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * The failure, in words that name what the parent can do.
 *
 * Only 429 earns its own sentence: it is the one outcome where waiting is the
 * answer. Everything else is "try again" -- a raw server message would be
 * English, or worse, a stack of validation strings.
 */
function sendErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    return 'שלחתם כמה דיווחים ברצף. נסו שוב מאוחר יותר';
  }
  return 'לא הצלחנו לשלוח את המשוב. נסו שוב';
}

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lets the launcher show the thank-you after the dialog has closed. */
  onSent: () => void;
}

/**
 * The feedback form.
 *
 * Mounted only while open, which is what keeps `useSubmitFeedback` and
 * `useProfile` -- both TanStack hooks -- out of `UserHeader`, a component its
 * own test renders with no QueryClientProvider.
 */
export function FeedbackDialog({ open, onOpenChange, onSent }: FeedbackDialogProps) {
  const pathname = usePathname();
  const { data: profiles } = useProfile();
  const submitMutation = useSubmitFeedback();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FeedbackForm>({
    resolver: zodResolver(schema),
    defaultValues: { subject: 'bug', subjectOther: '', contactEmail: '', content: '' },
  });

  const subject = watch('subject');
  const content = watch('content') ?? '';

  /**
   * The first school that actually has an address.
   *
   * A two-school household has one profile row per school, and a school whose
   * details were never filled in sends back an empty string -- which as a
   * prefill is worse than nothing, because the parent has to notice it is
   * blank before the server refuses it.
   */
  const prefillEmail = useMemo(
    () => profiles?.map((entry) => entry.email?.trim()).find((email) => Boolean(email)) ?? '',
    [profiles],
  );

  // Once, and only into an untouched field: the profile query can resolve
  // after the parent has already typed or cleared their own address.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !prefillEmail) return;
    prefilled.current = true;
    setValue('contactEmail', prefillEmail);
  }, [prefillEmail, setValue]);

  const firstFieldError =
    errors.subjectOther?.message ??
    errors.contactEmail?.message ??
    errors.content?.message ??
    errors.subject?.message;
  const errorMessage =
    firstFieldError ?? (submitMutation.isError ? sendErrorMessage(submitMutation.error) : null);

  const onValid = (values: FeedbackForm) => {
    const body: CreateFeedbackBody = {
      subject: values.subject,
      content: values.content,
      // Reproduction context, so the parent never has to describe it. Path
      // only: `usePathname` carries no query or hash, which can hold a guid.
      pagePath: pathname ?? undefined,
      viewportWidth: typeof window === 'undefined' ? undefined : window.innerWidth,
      viewportHeight: typeof window === 'undefined' ? undefined : window.innerHeight,
    };
    if (values.subject === 'other') body.subjectOther = values.subjectOther;
    if (values.contactEmail) body.contactEmail = values.contactEmail;

    const appVersion = process.env.NEXT_PUBLIC_APP_VERSION;
    // Omitted rather than sent empty, so the server can fall back to the build
    // it knows about itself.
    if (appVersion) body.appVersion = appVersion;

    submitMutation.mutate(body, {
      onSuccess: () => {
        onOpenChange(false);
        onSent();
      },
    });
  };

  const canSend = content.trim().length > 0 && !submitMutation.isPending;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]" />
        <Dialog.Content
          data-testid="feedback-dialog"
          lang="he-IL"
          dir="rtl"
          // `dvh`, not `vh`: `vh` does not shrink when the iOS keyboard rises,
          // so the submit button ends up under it with nothing to scroll.
          className="fixed inset-x-4 top-10 z-50 mx-auto max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-background p-4 shadow-xl sm:inset-x-0"
          // Autofocusing the textarea would raise the keyboard over the
          // subject picker before the parent has read it.
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="mb-4 flex items-start justify-between gap-2">
            <Dialog.Title className="text-lg font-semibold text-foreground">
              שליחת משוב
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="סגור" className="icon-button h-9 w-9">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <Dialog.Description className="mb-4 text-sm text-muted-foreground">
            ספרו לנו מה לא עובד או מה אפשר לשפר. נצרף אוטומטית את הדף שבו אתם נמצאים ואת בתי
            הספר המחוברים, כדי שנוכל לשחזר את מה שראיתם.
          </Dialog.Description>

          <form onSubmit={handleSubmit(onValid)} className="space-y-4" noValidate>
            <div>
              <label htmlFor="feedback-subject" className="mb-1 block text-sm text-foreground">
                נושא
              </label>
              {/*
                A native select, not `ui/Select` (Radix): the OS picker is
                better on a phone, it is RTL-safe, it registers with RHF
                directly, and it is reachable in jsdom. The styling is
                `SelectTrigger`'s, so the two still look alike.
              */}
              <select
                id="feedback-subject"
                data-testid="feedback-subject-select"
                className={`${FIELD_CLASS} h-11`}
                {...register('subject')}
              >
                {SUBJECT_ORDER.map((code) => (
                  <option key={code} value={code}>
                    {FEEDBACK_SUBJECT_LABELS[code]}
                  </option>
                ))}
              </select>
            </div>

            {subject === 'other' && (
              <div>
                <label
                  htmlFor="feedback-subject-other"
                  className="mb-1 block text-sm text-foreground"
                >
                  פירוט הנושא
                </label>
                <input
                  id="feedback-subject-other"
                  data-testid="feedback-subject-other-input"
                  type="text"
                  maxLength={SUBJECT_OTHER_MAX}
                  className={`${FIELD_CLASS} h-11`}
                  {...register('subjectOther')}
                />
              </div>
            )}

            <div>
              <label htmlFor="feedback-content" className="mb-1 block text-sm text-foreground">
                מה קרה?
              </label>
              <textarea
                id="feedback-content"
                data-testid="feedback-content-textarea"
                rows={5}
                maxLength={FEEDBACK_CONTENT_MAX}
                className={FIELD_CLASS}
                {...register('content')}
              />
              <p
                data-testid="feedback-content-counter"
                className="mt-1 text-xs text-muted-foreground"
              >
                {content.length} / {FEEDBACK_CONTENT_MAX}
              </p>
            </div>

            <div>
              <label htmlFor="feedback-email" className="mb-1 block text-sm text-foreground">
                אימייל לחזרה (לא חובה)
              </label>
              <input
                id="feedback-email"
                data-testid="feedback-email-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                maxLength={EMAIL_MAX}
                className={`${FIELD_CLASS} h-11`}
                {...register('contactEmail')}
              />
            </div>

            {errorMessage && (
              <p
                role="alert"
                data-testid="feedback-error"
                className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {errorMessage}
              </p>
            )}

            <div className="flex items-center justify-start gap-2">
              <button
                type="submit"
                data-testid="feedback-submit-button"
                disabled={!canSend}
                className="tap-target inline-flex items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {submitMutation.isPending ? 'שולח…' : 'שליחה'}
              </button>
              <button
                type="button"
                data-testid="feedback-cancel-button"
                onClick={() => onOpenChange(false)}
                className="tap-target inline-flex items-center justify-center rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                ביטול
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
