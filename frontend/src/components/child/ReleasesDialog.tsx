'use client';

import React, { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { createStudentRelease, updateStudentRelease, deleteStudentRelease } from '@/api/children';
import { useChildTimetable, useStudentReleases } from '@/hooks/useChild';
import type {
  CreateStudentReleaseBody,
  StudentRelease,
  TimetableEntry,
  UpdateStudentReleaseBody,
} from '@/types/api';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingState } from '@/components/ui/LoadingState';

interface ReleasesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studentGuid: string;
}

type ReleaseStatusVariant = 'info' | 'positive' | 'attention' | 'neutral';

const RELEASE_TIME_INPUT_CLASS =
  'w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50';

function statusMeta(status: number): { label: string; variant: ReleaseStatusVariant } {
  if (status === 1) return { label: 'בהמתנה', variant: 'info' };
  if (status === 2) return { label: 'מאושר', variant: 'positive' };
  if (status === 3) return { label: 'נדחה', variant: 'attention' };
  return { label: `סטטוס ${status}`, variant: 'neutral' };
}

function toDateInputValue(releaseDate: string): string {
  if (!releaseDate) return '';
  if (releaseDate.includes('T')) return releaseDate.split('T')[0] ?? '';
  return releaseDate.slice(0, 10);
}

function toTimeInputValue(startHour: string): string {
  if (!startHour) return '';
  return startHour.slice(0, 5);
}

function toApiHour(timeValue: string): string {
  if (!timeValue) return '00:00:00';
  return timeValue.length === 5 ? `${timeValue}:00` : timeValue;
}

function dateValueToDayOfWeek(dateValue: string): number | null {
  if (!dateValue) return null;
  const date = new Date(`${dateValue}T12:00:00`);
  const jsDay = date.getDay();
  return jsDay + 1;
}

function formatTeachers(teachers: TimetableEntry['teachers']): string {
  return teachers.map((teacher) => teacher.teacherName).join(', ');
}

interface LessonTimePickerProps {
  dateValue: string;
  todayStr: string;
  value: string;
  onChange: (time: string) => void;
  timetable: TimetableEntry[];
  /**
   * Period start times, from the school's bell schedule on the timetable
   * query this dialog already consumes (ADR-0037).
   *
   * This used to be a hardcoded, school-agnostic map in this file — a second
   * period-time table that could, and did, diverge from the one the timetable
   * grid shows. Empty here (an older backend, or a school whose periods are
   * all in the past) falls back to the free `<input type="time">` below.
   */
  lessonStartTimes: Map<number, string>;
  disabled?: boolean;
  fieldId?: string;
  name?: string;
  testId?: string;
}

function LessonTimePicker({
  dateValue,
  todayStr,
  value,
  onChange,
  timetable,
  lessonStartTimes,
  disabled = false,
  fieldId,
  name,
  testId,
}: LessonTimePickerProps) {
  const dayOfWeek = useMemo(() => dateValueToDayOfWeek(dateValue), [dateValue]);

  const dayLessons = useMemo(() => {
    if (dayOfWeek === null) return [];
    return timetable
      .filter((entry) => entry.day === dayOfWeek && Boolean(lessonStartTimes.get(entry.lesson)))
      .sort((left, right) => {
        if (left.lesson !== right.lesson) return left.lesson - right.lesson;
        return left.subjectName.localeCompare(right.subjectName, 'he');
      });
  }, [dayOfWeek, lessonStartTimes, timetable]);

  const futureLessons = useMemo(() => {
    const now = new Date();
    const isToday = dateValue === todayStr;
    return dayLessons.filter((entry) => {
      if (!isToday) return true;
      const [hour, minute] = (lessonStartTimes.get(entry.lesson) ?? '00:00')
        .split(':')
        .map(Number);
      const lessonMinutes = hour * 60 + (minute ?? 0);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      return lessonMinutes > nowMinutes;
    });
  }, [dateValue, dayLessons, lessonStartTimes, todayStr]);

  const slotTimes = useMemo(
    () => futureLessons.map((entry) => lessonStartTimes.get(entry.lesson) ?? ''),
    [futureLessons, lessonStartTimes],
  );

  useEffect(() => {
    if (!value) return;
    if (!dateValue) return;
    if (dayLessons.length === 0 || futureLessons.length === 0) return;
    if (slotTimes.includes(value)) return;
    onChange('');
  }, [dateValue, dayLessons.length, futureLessons.length, onChange, slotTimes, value]);

  if (!dateValue) {
    return (
      <select
        id={fieldId}
        name={name}
        data-testid={testId}
        value=""
        disabled
        className={RELEASE_TIME_INPUT_CLASS}
      >
        <option value="">בחר תאריך תחילה</option>
      </select>
    );
  }

  if (dayLessons.length === 0 || futureLessons.length === 0) {
    return (
      <input
        id={fieldId}
        name={name}
        data-testid={testId}
        type="time"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className={RELEASE_TIME_INPUT_CLASS}
      />
    );
  }

  const selectValue = slotTimes.includes(value) ? value : '';

  return (
    <select
      id={fieldId}
      name={name}
      data-testid={testId}
      value={selectValue}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className={RELEASE_TIME_INPUT_CLASS}
    >
      <option value="">בחר שעה</option>
      {futureLessons.map((entry) => {
        const lessonTime = lessonStartTimes.get(entry.lesson);
        const teachersLabel = formatTeachers(entry.teachers);
        const label = teachersLabel.length > 0
          ? `שיעור ${entry.lesson} — ${entry.subjectName} — ${teachersLabel} (${lessonTime})`
          : `שיעור ${entry.lesson} — ${entry.subjectName} (${lessonTime})`;
        return (
          <option key={`${entry.id}-${lessonTime}`} value={lessonTime}>
            {label}
          </option>
        );
      })}
    </select>
  );
}

function buildUpdateBody(
  release: StudentRelease,
  dateValue: string,
  timeValue: string,
  remarkValue: string,
): UpdateStudentReleaseBody {
  const nextStartHour = toApiHour(timeValue);
  const nextReleaseDate = `${dateValue}T00:00:00`;
  const releaseDateMoment = `${dateValue}T${nextStartHour}`;

  return {
    ...release,
    releaseDate: nextReleaseDate,
    startHour: nextStartHour,
    remark: remarkValue,
    releaseDateMoment,
    isExpired: Date.parse(releaseDateMoment) < Date.now(),
    isDirty_menu: true,
  };
}

function buildCreateBody(
  studentGuid: string,
  dateValue: string,
  timeValue: string,
  remarkValue: string,
): CreateStudentReleaseBody {
  return {
    releaseDate: `${dateValue}T02:00:00`,
    remark: remarkValue,
    studentGuid,
    startHour: toApiHour(timeValue),
  };
}

export function ReleasesDialog({
  open,
  onOpenChange,
  studentGuid,
}: ReleasesDialogProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useStudentReleases(studentGuid);
  const { data: timetableData } = useChildTimetable(open ? studentGuid : '');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('');
  const [editRemark, setEditRemark] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createDate, setCreateDate] = useState('');
  const [createTime, setCreateTime] = useState('');
  const [createRemark, setCreateRemark] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<StudentRelease | null>(null);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const timetable = timetableData?.data ?? [];
  const lessonStartTimes = useMemo(() => {
    const byLesson = new Map<number, string>();
    for (const period of timetableData?.schedule?.periods ?? []) {
      byLesson.set(period.lesson, period.startTime);
    }
    return byLesson;
  }, [timetableData?.schedule]);

  const createMutation = useMutation({
    mutationFn: () => {
      const body = buildCreateBody(studentGuid, createDate, createTime, createRemark);
      return createStudentRelease(studentGuid, body);
    },
    onSuccess: async () => {
      setIsCreating(false);
      setCreateDate('');
      setCreateTime('');
      setCreateRemark('');
      await queryClient.invalidateQueries({ queryKey: ['child', studentGuid, 'releases'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (release: StudentRelease) => {
      const body = buildUpdateBody(release, editDate, editTime, editRemark);
      return updateStudentRelease(studentGuid, release.id, body);
    },
    onSuccess: async () => {
      setEditingId(null);
      await queryClient.invalidateQueries({ queryKey: ['child', studentGuid, 'releases'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (releaseId: number) => deleteStudentRelease(studentGuid, releaseId),
    onSuccess: async () => {
      setDeleteTarget(null);
      if (editingId !== null && deleteTarget?.id === editingId) {
        setEditingId(null);
      }
      await queryClient.invalidateQueries({ queryKey: ['child', studentGuid, 'releases'] });
    },
  });

  const releases = useMemo(() => data ?? [], [data]);
  const mutationError = createMutation.error ?? updateMutation.error ?? deleteMutation.error;

  const handleStartCreate = () => {
    setIsCreating(true);
    setEditingId(null);
  };

  const handleCancelCreate = () => {
    setIsCreating(false);
    setCreateDate('');
    setCreateTime('');
    setCreateRemark('');
  };

  const handleCreate = () => {
    if (!createDate || !createTime) return;
    createMutation.mutate();
  };

  const handleStartEdit = (release: StudentRelease) => {
    setIsCreating(false);
    setEditingId(release.id);
    setEditDate(toDateInputValue(release.releaseDate));
    setEditTime(toTimeInputValue(release.startHour));
    setEditRemark(release.remark ?? '');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
  };

  const handleSave = (release: StudentRelease) => {
    if (!editDate || !editTime) return;
    updateMutation.mutate(release);
  };

  const isBusy = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]" />
          <Dialog.Content
            data-testid="releases-dialog"
            lang="he-IL"
            dir="rtl"
            className="dialog-panel fixed inset-x-4 top-12 z-50 mx-auto w-full max-w-2xl rounded-2xl border border-border bg-background p-4 shadow-xl sm:inset-x-0"
          >
            <div className="mb-4 flex items-start justify-between gap-2">
              <Dialog.Title className="text-lg font-semibold text-foreground">
                בקשות שחרור
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="סגור"
                  className="icon-button h-9 w-9"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="mb-4 flex justify-start">
              {!isCreating && (
                <button
                  type="button"
                  data-testid="release-create-toggle"
                  onClick={handleStartCreate}
                  disabled={isBusy}
                  className="tap-target inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  בקשה חדשה
                </button>
              )}
            </div>

            {!isLoading && !isError && isCreating && (
              <div className="mb-4 space-y-3 rounded-xl border border-border/80 bg-card/70 p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">תאריך שחרור</span>
                    <input
                      id="release-create-date"
                      name="release-create-date"
                      data-testid="release-create-date"
                      type="date"
                      lang="he-IL"
                      min={todayStr}
                      value={createDate}
                      onChange={(event) => setCreateDate(event.target.value)}
                      className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">שעת שחרור</span>
                    <LessonTimePicker
                      dateValue={createDate}
                      todayStr={todayStr}
                      value={createTime}
                      onChange={setCreateTime}
                      timetable={timetable}
                      lessonStartTimes={lessonStartTimes}
                      disabled={isBusy}
                      fieldId="release-create-time"
                      name="release-create-time"
                      testId="release-create-time"
                    />
                  </label>
                </div>
                <label className="block space-y-1 text-sm">
                  <span className="text-muted-foreground">הערה</span>
                  <textarea
                    id="release-create-remark"
                    name="release-create-remark"
                    data-testid="release-create-remark"
                    value={createRemark}
                    onChange={(event) => setCreateRemark(event.target.value)}
                    rows={3}
                    className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="release-create-submit"
                    onClick={handleCreate}
                    disabled={isBusy || !createDate || !createTime}
                    className="tap-target rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    שלח בקשה
                  </button>
                  <button
                    type="button"
                    data-testid="release-create-cancel"
                    onClick={handleCancelCreate}
                    disabled={isBusy}
                    className="tap-target rounded-full border border-border/80 px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    ביטול
                  </button>
                </div>
              </div>
            )}

            {isLoading && <LoadingState message="טוען בקשות שחרור..." className="py-8" />}

            {isError && !isLoading && (
              <ErrorState
                message="לא ניתן לטעון בקשות שחרור"
                onRetry={() => void refetch()}
              />
            )}

            {!isLoading && !isError && releases.length === 0 && (
              <EmptyState title="אין בקשות שחרור" subtitle="לא נמצאו בקשות פעילות עבור הילד" />
            )}

            {!isLoading && !isError && releases.length > 0 && (
              <div className="space-y-3">
                {releases.map((release) => {
                  const isEditing = editingId === release.id;
                  const status = statusMeta(release.status);

                  return (
                    <article
                      key={release.id}
                      data-testid={`release-item-${release.id}`}
                      className="card-base p-4"
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Badge variant={status.variant}>{status.label}</Badge>
                        <span className="text-sm font-medium text-foreground">
                          {toDateInputValue(release.releaseDate)}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {toTimeInputValue(release.startHour)}
                        </span>
                      </div>

                      {!isEditing && (
                        <p className="mb-3 whitespace-pre-wrap text-sm text-foreground">
                          {release.remark || 'ללא הערה'}
                        </p>
                      )}

                      {isEditing && (
                        <div className="mb-3 space-y-3 rounded-xl border border-border/80 bg-card/70 p-3">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1 text-sm">
                              <span className="text-muted-foreground">תאריך שחרור</span>
                              <input
                                id={`release-date-${release.id}`}
                                name={`release-date-${release.id}`}
                                data-testid={`release-date-${release.id}`}
                                type="date"
                                lang="he-IL"
                                min={todayStr}
                                value={editDate}
                                onChange={(event) => setEditDate(event.target.value)}
                                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                              />
                            </label>
                            <label className="space-y-1 text-sm">
                              <span className="text-muted-foreground">שעת שחרור</span>
                              <LessonTimePicker
                                dateValue={editDate}
                                todayStr={todayStr}
                                value={editTime}
                                onChange={setEditTime}
                                timetable={timetable}
                                lessonStartTimes={lessonStartTimes}
                                disabled={isBusy}
                                fieldId={`release-time-${release.id}`}
                                name={`release-time-${release.id}`}
                                testId={`release-time-${release.id}`}
                              />
                            </label>
                          </div>
                          <label className="block space-y-1 text-sm">
                            <span className="text-muted-foreground">הערה</span>
                            <textarea
                              id={`release-remark-${release.id}`}
                              name={`release-remark-${release.id}`}
                              data-testid={`release-remark-${release.id}`}
                              value={editRemark}
                              onChange={(event) => setEditRemark(event.target.value)}
                              rows={3}
                              className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                            />
                          </label>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-2">
                        {!isEditing && (
                          <button
                            type="button"
                            data-testid={`release-edit-${release.id}`}
                            onClick={() => handleStartEdit(release)}
                            disabled={isBusy}
                            className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                          >
                            <Pencil className="h-4 w-4" />
                            ערוך
                          </button>
                        )}

                        {isEditing && (
                          <>
                            <button
                              type="button"
                              data-testid={`release-save-${release.id}`}
                              onClick={() => handleSave(release)}
                              disabled={isBusy || !editDate || !editTime}
                              className="tap-target rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                            >
                              שמור
                            </button>
                            <button
                              type="button"
                              data-testid={`release-cancel-${release.id}`}
                              onClick={handleCancelEdit}
                              disabled={isBusy}
                              className="tap-target rounded-full border border-border/80 px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                            >
                              ביטול
                            </button>
                          </>
                        )}

                        <button
                          type="button"
                          data-testid={`release-delete-${release.id}`}
                          onClick={() => setDeleteTarget(release)}
                          disabled={isBusy}
                          className="tap-target inline-flex items-center gap-1 rounded-full border border-destructive/40 px-3 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                        >
                          <Trash2 className="h-4 w-4" />
                          מחק
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {mutationError && (
              <p className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
                הפעולה נכשלה. נסה שוב.
              </p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AlertDialog.Root
        open={Boolean(deleteTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteTarget(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/55" />
          <AlertDialog.Content
            dir="rtl"
            className="dialog-panel fixed inset-x-4 top-1/2 z-[61] mx-auto w-full max-w-sm -translate-y-1/2 rounded-2xl border border-border bg-background p-4 shadow-xl"
          >
            <AlertDialog.Title className="text-base font-semibold text-foreground">
              למחוק בקשת שחרור?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
              הפעולה תמחק את הבקשה לצמיתות.
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  data-testid="release-delete-cancel"
                  disabled={deleteMutation.isPending}
                  className="tap-target rounded-full border border-border/80 px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  ביטול
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  data-testid="release-delete-confirm"
                  onClick={() => {
                    if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
                  }}
                  disabled={deleteMutation.isPending}
                  className="tap-target rounded-full bg-destructive px-4 py-1.5 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  מחק
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
