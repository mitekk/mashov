'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, BellRing, CheckCircle2, Loader2, Send, TriangleAlert } from 'lucide-react';
import { useChildren } from '@/hooks/useChildren';
import { useDigestRecipients } from '@/hooks/useDigestRecipients';
import { useCreateTelegramLink, useTelegramLinkState } from '@/hooks/useTelegramLink';
import { ApiError } from '@/api/client';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import type { ChildListItem, TelegramLink } from '@/types/api';

type Step = 'intro' | 'children' | 'start' | 'done';

const NOT_CONFIGURED_MESSAGE =
  'הצד השרת של האפליקציה לא מוגדר לשליחת עדכונים בטלגרם. פנו למי שמפעיל את האפליקציה.';
const FALLBACK_MESSAGE = 'לא הצלחנו ליצור קישור כרגע. נסו שוב בעוד רגע.';

/** Stable empty identity for the not-yet-seeded choice. */
const NO_CHILDREN: string[] = [];

function mintErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: { code?: string } })?.error?.code;
    if (code === 'TELEGRAM_NOT_CONFIGURED' || code === 'TELEGRAM_UNAVAILABLE') {
      return NOT_CONFIGURED_MESSAGE;
    }
    if (code === 'FORBIDDEN') {
      return 'אחד הילדים שנבחרו אינו מופיע בחשבון שלכם. רעננו את המסך ונסו שוב.';
    }
  }
  return FALLBACK_MESSAGE;
}

/**
 * Connecting a parent's own Telegram, in four screens.
 *
 * A route rather than a modal, for the reasons the add-school screen gives:
 * real back-button behaviour on a phone, a shareable URL, and a page object a
 * test can drive. `/more/...` already passes the phase-1 route gate, so neither
 * `lib/phase1-routes.ts` nor `middleware.ts` needs touching.
 *
 * The steps live in component state rather than in the URL, because the middle
 * step is a *wait* on an external action: a back button that returned to "press
 * START" after the START had already been consumed would offer a dead code. The
 * only navigation out is finishing, or back.
 */
export default function TelegramSetupPageClient() {
  const router = useRouter();
  const { data: childrenResponse, isLoading, isError } = useChildren();
  // useChildren resolves the envelope, not the array.
  const children = childrenResponse?.data;
  // What the parent is already subscribed to, so the pre-tick below does not
  // quietly undo a child they switched off.
  const { data: recipients, isLoading: recipientsLoading } = useDigestRecipients();

  const [step, setStep] = useState<Step>('intro');
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [link, setLink] = useState<TelegramLink | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);

  const mint = useCreateTelegramLink();

  // Only polled from the step that is waiting, and from the one that reports
  // the result -- the hook itself stops once the link resolves either way.
  const { data: linkState } = useTelegramLinkState(
    step === 'start' || step === 'done' ? (link?.code ?? null) : null,
  );

  // Pre-ticked, once, as soon as the roster AND the existing subscriptions are
  // known. Seeded from a null sentinel rather than an empty array so that a
  // parent who unticks everyone is not immediately re-ticked by this effect.
  //
  // A child with a switched-off subscription starts unticked. Otherwise
  // "הוספת ילד" -- whose only route is this wizard -- would re-tick them, and
  // one START would resubscribe a child the parent had deliberately turned off
  // in /more, since the backend's upsert sets enabled: true for whatever it is
  // given. Unticked is a default, not a lock: ticking it again is a deliberate
  // choice and does re-enable them.
  useEffect(() => {
    if (chosen !== null || !children || recipientsLoading) return;

    const switchedOff = new Set(
      (recipients ?? [])
        .filter((row) => row.channel === 'telegram' && !row.enabled)
        .map((row) => row.studentGuid),
    );
    setChosen(
      children
        .map((item) => item.studentGuid)
        .filter((studentGuid) => !switchedOff.has(studentGuid)),
    );
  }, [chosen, children, recipients, recipientsLoading]);

  // The step-3 wait resolves itself: no "I pressed it" button to get wrong.
  useEffect(() => {
    if (step === 'start' && linkState?.status === 'linked') setStep('done');
  }, [step, linkState?.status]);

  // A module-level constant, not a fresh `[]`: an inline literal would be a new
  // array identity every render and so defeat the useMemo below it.
  const ticked = chosen ?? NO_CHILDREN;
  const schoolCount = useMemo(() => countSchools(children), [children]);
  /**
   * The children the SERVER subscribed, not the ones the client ticked.
   *
   * A child whose roster links moved between minting and START is skipped by
   * `consume()`, and the Telegram confirmation correctly names only the rest --
   * so naming the ticks here would have the screen and the message disagree
   * about the same link.
   */
  const subscribedChildren = useMemo(() => {
    const guids = linkState?.subscribedGuids ?? [];
    return (children ?? []).filter((item) => guids.includes(item.studentGuid));
  }, [children, linkState?.subscribedGuids]);

  function toggle(studentGuid: string): void {
    setChosen((current) => {
      const list = current ?? [];
      return list.includes(studentGuid)
        ? list.filter((guid) => guid !== studentGuid)
        : [...list, studentGuid];
    });
  }

  /** Mint and move to the waiting step. Also the "give me a fresh one" path. */
  function requestLink(): void {
    setMintError(null);
    mint.mutate(ticked, {
      onSuccess: (minted) => {
        setLink(minted);
        setStep('start');
      },
      onError: (error) => setMintError(mintErrorMessage(error)),
    });
  }

  return (
    <div data-testid="telegram-setup-page" className="min-h-dvh bg-background px-4 py-6">
      <div className="mx-auto w-full max-w-sm">
        <button
          type="button"
          data-testid="telegram-back-btn"
          onClick={() => router.back()}
          className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
          חזרה
        </button>

        {isLoading && <LoadingState message="טוען..." />}
        {isError && <ErrorState />}

        {!isLoading && !isError && step === 'intro' && (
          <IntroStep onContinue={() => setStep('children')} />
        )}

        {!isLoading && !isError && step === 'children' && (
          <ChildrenStep
            items={children ?? []}
            ticked={ticked}
            showSchoolLabels={schoolCount > 1}
            pending={mint.isPending}
            error={mintError}
            onToggle={toggle}
            onContinue={requestLink}
          />
        )}

        {!isError && step === 'start' && link && (
          <StartStep
            link={link}
            expired={linkState?.status === 'expired'}
            retrying={mint.isPending}
            error={mintError}
            onRetry={requestLink}
          />
        )}

        {!isError && step === 'done' && (
          <DoneStep
            items={subscribedChildren}
            deliveryEnabled={linkState?.deliveryEnabled ?? false}
            confirmationSent={linkState?.confirmationSent ?? false}
            confirmationPending={linkState?.confirmationPending ?? false}
            confirmationError={linkState?.confirmationError ?? null}
          />
        )}
      </div>
    </div>
  );
}

/**
 * `א, ב וג` rather than `א וב וג`.
 *
 * Hebrew joins a list with commas and a single ו before the last item. Two
 * names take just the ו, which is why the naive join read correctly until a
 * third child existed.
 */
function hebrewList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ו${names[names.length - 1]}`;
}

/** How many distinct schools the roster spans. Drives the per-row labels. */
function countSchools(children: ChildListItem[] | undefined): number {
  const schools = new Set((children ?? []).map((item) => item.schoolId ?? 'unknown'));
  return schools.size;
}

function IntroStep({ onContinue }: { onContinue: () => void }) {
  return (
    <section data-testid="telegram-step-intro">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <BellRing className="h-6 w-6 text-primary" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">עדכונים בטלגרם</h1>
      </div>

      <div className="card-base space-y-4 p-5 text-sm leading-relaxed text-foreground">
        <p>
          אחרי הצהריים נשלח לכם הודעה אחת על כל ילד — מה היה בשיעורי הבית, מה נרשם בהתנהגות,
          ומה כדאי לדעת לקראת מחר.
        </p>
        <p className="text-muted-foreground">
          ביום שבו לא קרה שום דבר חדש, לא תקבלו הודעה בכלל. אין התראות סתם.
        </p>
        <p className="text-muted-foreground">
          טלגרם היא אפליקציית הודעות חינמית. אם היא לא מותקנת אצלכם, הכפתור במסך הבא יפתח את
          החנות כדי להתקין אותה.
        </p>
      </div>

      <button
        type="button"
        data-testid="telegram-intro-continue-btn"
        onClick={onContinue}
        className="mt-5 w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
      >
        בואו נתחיל
      </button>
    </section>
  );
}

interface ChildrenStepProps {
  items: ChildListItem[];
  ticked: string[];
  showSchoolLabels: boolean;
  pending: boolean;
  error: string | null;
  onToggle: (studentGuid: string) => void;
  onContinue: () => void;
}

function ChildrenStep(props: ChildrenStepProps) {
  const { items, ticked, showSchoolLabels, pending, error, onToggle, onContinue } = props;

  return (
    <section data-testid="telegram-step-children">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">על מי תרצו לשמוע?</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          תקבלו הודעה נפרדת על כל ילד שתסמנו. אפשר לשנות את זה בכל רגע אחר כך.
        </p>
      </div>

      {items.length === 0 ? (
        <p
          data-testid="telegram-children-empty"
          className="card-base p-5 text-sm text-muted-foreground"
        >
          אין כרגע ילדים בחשבון. אחרי שהסנכרון הראשון יסתיים הם יופיעו כאן.
        </p>
      ) : (
        <div className="card-base divide-y divide-border">
          {items.map((item) => (
            <label
              key={item.studentGuid}
              htmlFor={`telegram-child-toggle-${item.studentGuid}`}
              className="flex cursor-pointer items-center gap-3 p-4"
            >
              <input
                id={`telegram-child-toggle-${item.studentGuid}`}
                data-testid={`telegram-child-toggle-${item.studentGuid}`}
                type="checkbox"
                checked={ticked.includes(item.studentGuid)}
                onChange={() => onToggle(item.studentGuid)}
                className="h-5 w-5 flex-shrink-0 rounded border-input accent-primary"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">
                  {item.fullName}
                </span>
                <span className="block text-xs text-muted-foreground">
                  כיתה {item.classCode}
                  {item.classNum}
                  {showSchoolLabels && item.schoolShortLabel && (
                    <>
                      {' · '}
                      <span data-testid={`telegram-child-school-${item.studentGuid}`}>
                        {item.schoolShortLabel}
                      </span>
                    </>
                  )}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}

      {error && (
        <p
          data-testid="telegram-children-error"
          role="alert"
          className="mt-4 rounded-xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        data-testid="telegram-children-continue-btn"
        disabled={ticked.length === 0 || pending}
        onClick={onContinue}
        className="mt-5 w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
      >
        {pending ? 'רגע...' : 'המשך'}
      </button>
    </section>
  );
}

interface StartStepProps {
  link: TelegramLink;
  expired: boolean;
  retrying: boolean;
  error: string | null;
  onRetry: () => void;
}

function StartStep({ link, expired, retrying, error, onRetry }: StartStepProps) {
  return (
    <section data-testid="telegram-step-start">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">נותר צעד אחד</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          לחצו על הכפתור, ובטלגרם שייפתח לחצו על <span className="font-semibold">START</span>.
          זה כל מה שצריך — אין מה להקליד או להעתיק.
        </p>
      </div>

      {expired ? (
        <div className="card-base space-y-4 p-5">
          <p className="text-sm text-foreground">
            הקישור פג תוקף. אפשר לקבל קישור חדש ולהמשיך מכאן.
          </p>
          <button
            type="button"
            data-testid="telegram-start-retry-btn"
            disabled={retrying}
            onClick={onRetry}
            className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {retrying ? 'רגע...' : 'קישור חדש'}
          </button>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      ) : (
        <>
          <a
            data-testid="telegram-start-btn"
            href={link.deepLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-4 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Send className="h-5 w-5" aria-hidden="true" />
            פתיחת טלגרם
          </a>

          <div
            data-testid="telegram-start-waiting"
            className="mt-5 flex items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ממתינים לכם... המסך יתקדם מעצמו
          </div>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            הקישור בתוקף למשך 15 דקות. אם הוא פג, נציע לכם כאן קישור חדש.
          </p>
        </>
      )}
    </section>
  );
}

interface DoneStepProps {
  items: ChildListItem[];
  deliveryEnabled: boolean;
  confirmationSent: boolean;
  confirmationPending: boolean;
  confirmationError: string | null;
}

function DoneStep({
  items,
  deliveryEnabled,
  confirmationSent,
  confirmationPending,
  confirmationError,
}: DoneStepProps) {
  return (
    <section data-testid="telegram-step-done">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <CheckCircle2 className="h-6 w-6 text-primary" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">מחובר</h1>
      </div>

      <div className="card-base space-y-4 p-5 text-sm leading-relaxed text-foreground">
        {confirmationSent && <p>שלחנו לכם עכשיו הודעה בטלגרם — כדאי לבדוק שהיא הגיעה.</p>}

        {/* Neither sent nor failed: the server has bound the chat and is still
            sending. Saying nothing arrived here would be a red error on a link
            that is working. */}
        {!confirmationSent && confirmationPending && (
          <p
            data-testid="telegram-done-confirmation-pending"
            className="flex items-center gap-2 text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            שולחים לכם הודעה בטלגרם...
          </p>
        )}

        {!confirmationSent && !confirmationPending && (
          <p data-testid="telegram-done-confirmation-failed" className="text-destructive">
            החיבור נשמר, אבל הודעת האישור לא הגיעה
            {confirmationError ? ` (${confirmationError})` : ''}. אם חסמתם את השיחה בטלגרם,
            פתחו אותה שוב ולחצו START.
          </p>
        )}

        {items.length > 0 ? (
          <p data-testid="telegram-done-children" className="text-muted-foreground">
            מעכשיו תקבלו עדכונים על {hebrewList(items.map((item) => item.privateName))}.
          </p>
        ) : (
          // The server subscribed nobody -- every chosen child's roster links
          // moved in the meantime. The Telegram message says so too; the screen
          // must not list the ticks as though they had taken.
          <p data-testid="telegram-done-nobody" className="text-muted-foreground">
            לא נרשם אף ילד לעדכונים. פתחו את מסך &quot;עוד&quot; ובחרו שוב על מי תרצו לשמוע.
          </p>
        )}

        {!deliveryEnabled && (
          <p
            data-testid="telegram-done-delivery-off"
            className="flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2.5 text-destructive"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span>
              שליחת העדכונים היומיים כבויה כרגע בשרת הזה, כך שלא יישלחו הודעות עד שמי שמפעיל
              את האפליקציה יפעיל אותה.
            </span>
          </p>
        )}
      </div>

      <Link
        data-testid="telegram-done-back-btn"
        href="/more"
        className="mt-5 block w-full rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
      >
        חזרה להגדרות
      </Link>
    </section>
  );
}
