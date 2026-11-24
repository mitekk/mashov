'use client';

import React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CheckCircle2, TriangleAlert } from 'lucide-react';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { ApiError } from '@/api/client';
import {
  useAdminFeedbackDetail,
  useMarkAdminFeedbackResponded,
} from '@/hooks/useAdminFeedback';
import type { AdminFeedbackDetail } from '@/types/api';
import { subjectLabel } from '../subject';

function formatStamp(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });
}

function Field({
  label,
  value,
  testId,
  dir,
}: {
  label: string;
  value: React.ReactNode;
  testId?: string;
  dir?: 'auto';
}) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 py-2 last:border-b-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm text-foreground" data-testid={testId} dir={dir}>
        {value}
      </dd>
    </div>
  );
}

function Detail({ report }: { report: AdminFeedbackDetail }) {
  const respond = useMarkAdminFeedbackResponded(report.id);

  return (
    <div className="split-pane pt-4">
      <article className="card-base p-4" data-testid="admin-feedback-detail">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold text-foreground" dir="auto">
            {subjectLabel(report.subject)}
            {report.subjectOther ? ` — ${report.subjectOther}` : ''}
          </h1>
          <time className="text-xs text-muted-foreground" dateTime={report.createdAt}>
            {formatStamp(report.createdAt)}
          </time>
        </header>

        {/* `dir="auto"` rather than `rtl`: the parent's own words are usually
            Hebrew but may be anything, and the browser decides per paragraph
            from the first strong character. `whitespace-pre-wrap` keeps the
            line breaks they typed. */}
        <p
          className="whitespace-pre-wrap pt-4 text-sm leading-relaxed text-foreground"
          dir="auto"
          data-testid="admin-feedback-content"
        >
          {report.content}
        </p>

        <div className="pt-4">
          {report.respondedAt === null ? (
            <button
              type="button"
              data-testid="admin-feedback-mark-responded"
              disabled={respond.isPending}
              onClick={() => respond.mutate()}
              className="tap-target inline-flex items-center gap-2 rounded-full border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {respond.isPending ? 'Saving...' : 'Mark as answered'}
            </button>
          ) : (
            <p
              className="inline-flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="admin-feedback-responded-at"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Answered {formatStamp(report.respondedAt)}
            </p>
          )}
          {respond.isError && (
            <p className="pt-2 text-sm text-destructive" data-testid="admin-feedback-respond-error">
              Could not save that. Try again.
            </p>
          )}
        </div>
      </article>

      <aside className="card-base p-4">
        <h2 className="pb-2 text-sm font-semibold text-foreground">Report details</h2>
        <dl>
          <Field
            label="Reporter"
            value={`${report.displayName} (${report.username})`}
            testId="admin-feedback-reporter"
            dir="auto"
          />
          <Field
            label="Reply to"
            value={
              report.contactEmail ? (
                <a
                  href={`mailto:${report.contactEmail}`}
                  className="text-primary underline underline-offset-4"
                  data-testid="admin-feedback-contact-email"
                >
                  {report.contactEmail}
                </a>
              ) : (
                'No reply address'
              )
            }
          />
          <Field label="Schools" value={report.schools.join(', ') || 'none'} dir="auto" />
          <Field label="Page" value={report.pagePath ?? 'unknown'} />
          <Field label="App version" value={report.appVersion ?? 'unknown'} />
          <Field
            label="Viewport"
            value={
              report.viewportWidth && report.viewportHeight
                ? `${report.viewportWidth} × ${report.viewportHeight}`
                : 'unknown'
            }
          />
          <Field label="User agent" value={report.userAgent ?? 'unknown'} />
          <Field label="Mashov user" value={report.mashovUserId} />
          <Field label="First opened" value={formatStamp(report.readAt)} testId="admin-feedback-read-at" />
          {/* The delivery state belongs on the screen that replaces the
              notification: a report the outbox gave up on would otherwise be
              invisible to the only person who could notice. */}
          <Field
            label="Telegram delivery"
            value={
              report.notifiedAt
                ? `Delivered ${formatStamp(report.notifiedAt)}`
                : `Not delivered after ${report.notifyAttempts} attempt(s)`
            }
            testId="admin-feedback-delivery"
          />
          {report.notifyError && (
            <Field
              label="Last delivery error"
              value={
                <span className="inline-flex items-start gap-1.5 text-destructive">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {report.notifyError}
                </span>
              }
              testId="admin-feedback-notify-error"
            />
          )}
          <Field label="Row id" value={<code className="text-xs">{report.id}</code>} />
        </dl>
      </aside>
    </div>
  );
}

/**
 * One report, read and triaged.
 *
 * Standalone like the list: no `AppShell`, `dir="ltr"`, English labels. The
 * GET this renders is what stamps `readAt` server-side -- so arriving here is
 * what clears the report's "new" state, with nothing for this component to
 * remember to fire.
 */
export default function AdminFeedbackDetailClient() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  const { data, isLoading, isError, error, refetch } = useAdminFeedbackDetail(id);

  const notFound = error instanceof ApiError && error.status === 404;

  return (
    <div dir="ltr" className="page-shell page-shell-wide" data-testid="admin-feedback-detail-page">
      <div className="pt-5">
        <Link
          href="/admin/feedback"
          data-testid="admin-feedback-back"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to triage
        </Link>
      </div>

      {isLoading && <LoadingState message="Loading report..." />}
      {!isLoading && isError && (
        <div className="pt-4">
          <ErrorState
            message={notFound ? 'That report does not exist.' : 'Could not load this report.'}
            onRetry={notFound ? undefined : () => void refetch()}
          />
        </div>
      )}
      {!isLoading && !isError && data && <Detail report={data.data} />}
    </div>
  );
}
