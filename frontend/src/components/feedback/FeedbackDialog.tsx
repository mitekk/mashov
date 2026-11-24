'use client';

import React, { useEffect, useMemo, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, X } from 'lucide-react';
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

/**
 * Close enough to the server's `@IsEmail` that the two do not disagree.
 *
 * The server is still the authority, but a client check that is LOOSER is
 * worse than none: `a@b..c` used to pass here and be refused there, and the
 * send failure named no field, so the parent retried an address that could
 * never be accepted. Dots may not lead, trail or repeat on either side, and
 * the TLD is letters.
 */
const EMAIL_SHAPE =
  /^[^\s@.]+(\.[^\s@.]+)*@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/;

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
  // A 400 means the server refused a field this form thought was fine. The
  // envelope's `details` carry only English class-validator sentences and no
  // field name, so there is nothing to pin to an input -- but "try again" is
  // the one piece of advice that is guaranteed not to work, so say what will.
  if (error instanceof ApiError && error.status === 400) {
    return 'אחד הפרטים לא התקבל. בדקו את כתובת האימייל ואת תוכן ההודעה';
  }
  return 'לא הצלחנו לשלוח את המשוב. נסו שוב';
}

/**
 * One field's error, inline and owned by that field.
 *
 * `.claude/rules/frontend.md` asks for field-level errors: an aggregated
 * first-error-only line costs a parent with two bad fields a second round
 * trip, and gives a screen-reader user no way to tell which control a bare
 * sentence belongs to. The id is what `aria-describedby` points at.
 */
function FieldError({ id, testId, message }: { id: string; testId: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} data-testid={testId} className="mt-1 text-xs text-destructive">
      {message}
    </p>
  );
}

/** `aria-describedby` takes a space-separated list; absent beats empty. */
function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => Boolean(id));
  return present.length > 0 ? present.join(' ') : undefined;
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
  const contentRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const { data: profiles } = useProfile();
  const submitMutation = useSubmitFeedback();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, dirtyFields },
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

  // Once, and only into an untouched field. The ref alone is not enough: on a
  // cold load the profile query resolves AFTER the parent has started typing,
  // and without the dirty check this effect would replace their own address
  // with the Mashov one -- silently, and a reply would go somewhere they chose
  // not to use. `dirtyFields` also covers the parent who deliberately cleared
  // it.
  const prefilled = useRef(false);
  const emailTouched = Boolean(dirtyFields.contactEmail);
  useEffect(() => {
    if (prefilled.current || emailTouched || !prefillEmail) return;
    prefilled.current = true;
    setValue('contactEmail', prefillEmail);
  }, [emailTouched, prefillEmail, setValue]);

  // The banner is for the SEND failure only -- the one thing no field owns.
  // Every validation message renders under its own input instead.
  const sendError = submitMutation.isError ? sendErrorMessage(submitMutation.error) : null;

  const onValid = (values: FeedbackForm) => {
    const body: CreateFeedbackBody = {
      subject: values.subject,
      content: values.content,
      // Reproduction context, so the parent never has to describe it.
      // `usePathname` is the path without query or hash. It does include the
      // child guid on `/children/<guid>` -- the reporting parent's own child,
      // and the only thing tying "the timetable is wrong" to a child.
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
          ref={contentRef}
          data-testid="feedback-dialog"
          lang="he-IL"
          dir="rtl"
          // `dvh`, not `vh`: `vh` does not shrink when the iOS keyboard rises,
          // so the submit button ends up under it with nothing to scroll.
          // `max-w-[calc(100%-2rem)]`, not `w-full`: with `position: fixed`,
          // `w-full` resolves against the VIEWPORT, so a 360px phone gets a
          // 360px box between two 16px insets. CSS resolves that
          // over-constraint by honouring the inline-start inset and letting the
          // rest hang off the physical left edge. `sm:inset-x-0` hid it at
          // >=640px, which is why it survived in ReleasesDialog (untouched
          // here -- same idiom, its own change).
          className="fixed inset-x-4 top-10 z-50 mx-auto max-h-[85dvh] w-auto max-w-lg overflow-y-auto rounded-2xl border border-border bg-background p-4 shadow-xl sm:inset-x-0 sm:w-full sm:max-w-lg"
          // Two requirements pulling against each other. Letting the open
          // focus land on a text field would raise the phone keyboard over the
          // subject picker before the parent had read it -- but merely
          // preventing it leaves focus on the launcher button OUTSIDE this
          // element, and Radix's focus trap only holds once focus is inside,
          // so the next Tab walks the page behind the overlay. Focusing the
          // dialog itself satisfies both.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
        >
          <div className="mb-4 flex items-start justify-between gap-2">
            <Dialog.Title className="text-lg font-semibold text-foreground">
              שליחת משוב
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="feedback-close-button"
                aria-label="סגור"
                className="icon-button h-9 w-9"
              >
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
              {/*
                `appearance-none` plus our own chevron: the browser draws the
                native arrow flush against the control's inline-end edge,
                ignoring the padding, which reads as a glyph stuck to the
                border. Ours sits at `end-3`, matching `SelectTrigger`. The
                picker itself stays native -- `appearance-none` styles the
                closed control, not the popup.
              */}
              <div className="relative">
                <select
                  id="feedback-subject"
                  data-testid="feedback-subject-select"
                  className={`${FIELD_CLASS} h-11 appearance-none pe-9`}
                  aria-invalid={errors.subject ? true : undefined}
                  aria-describedby={describedBy(errors.subject && 'feedback-subject-error')}
                  {...register('subject')}
                >
                  {SUBJECT_ORDER.map((code) => (
                    <option key={code} value={code}>
                      {FEEDBACK_SUBJECT_LABELS[code]}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                />
              </div>
              {/*
                Kept although the native select offers only the seven valid
                codes, so `z.enum` cannot fail short of devtools tampering.
                Without it that tampered submit is blocked by the resolver and
                shows nothing at all, which looks like a dead button.
              */}
              <FieldError
                id="feedback-subject-error"
                testId="feedback-subject-error"
                message={errors.subject?.message}
              />
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
                  aria-invalid={errors.subjectOther ? true : undefined}
                  aria-describedby={describedBy(
                    errors.subjectOther && 'feedback-subject-other-error',
                  )}
                  {...register('subjectOther')}
                />
                <FieldError
                  id="feedback-subject-other-error"
                  testId="feedback-subject-other-error"
                  message={errors.subjectOther?.message}
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
                aria-invalid={errors.content ? true : undefined}
                // The counter is in here too: `maxLength` truncates a long
                // paste silently, so a screen-reader user who is not told the
                // limit has no way to learn it.
                aria-describedby={describedBy(
                  'feedback-content-counter',
                  errors.content && 'feedback-content-error',
                )}
                {...register('content')}
              />
              <p
                id="feedback-content-counter"
                data-testid="feedback-content-counter"
                className="mt-1 text-xs text-muted-foreground"
              >
                {/*
                  Isolated LTR: in this `dir="rtl"` dialog bidi reorders a bare
                  `0 / 2000` into `2000 / 0`, so the parent reads the cap as
                  their own count.
                */}
                <span dir="ltr">
                  {content.length} / {FEEDBACK_CONTENT_MAX}
                </span>
              </p>
              <FieldError
                id="feedback-content-error"
                testId="feedback-content-error"
                message={errors.content?.message}
              />
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
                aria-invalid={errors.contactEmail ? true : undefined}
                aria-describedby={describedBy(errors.contactEmail && 'feedback-email-error')}
                {...register('contactEmail')}
              />
              <FieldError
                id="feedback-email-error"
                testId="feedback-email-error"
                message={errors.contactEmail?.message}
              />
            </div>

            {sendError && (
              <p
                role="alert"
                data-testid="feedback-error"
                className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {sendError}
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
