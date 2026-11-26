import {
  PER_STUDENT_SOURCES,
  policyForSource,
  policyForTask,
  SOURCE_POLICY,
  sourcesForSet,
  syncTtlMsFor,
  type SyncTaskSet,
} from './source-policy';

import { AchvasTask } from './tasks/achvas.task';
import { BehaviorTask } from './tasks/behavior.task';
import { BellsTask } from './tasks/bells.task';
import { DailyBehaveTask } from './tasks/daily-behave.task';
import { GradesTask } from './tasks/grades.task';
import { GroupsTask } from './tasks/groups.task';
import { HomeworkTask } from './tasks/homework.task';
import { LessonsCountTask } from './tasks/lessons-count.task';
import { MailCountsTask } from './tasks/mail-counts.task';
import { MailInboxTask } from './tasks/mail-inbox.task';
import { MessageBoardTask } from './tasks/message-board.task';
import { OutBehaveTask } from './tasks/out-behave.task';
import { ReleasesTask } from './tasks/releases.task';
import { SchoolActivitiesTask } from './tasks/school-activities.task';
import { StudentsTask } from './tasks/students.task';
import { TimetableTask } from './tasks/timetable.task';
import { UserDetailsTask } from './tasks/user-details.task';

/**
 * Every task that writes a `sync_run`. Reflected over rather than listed by
 * hand so that adding a task without a policy row fails here — a source with
 * no policy has an undefined TTL, which the read path would read as "always
 * expired" and fetch on every single view.
 */
const ALL_TASK_SOURCES = [
  AchvasTask.SOURCE,
  BehaviorTask.SOURCE,
  BellsTask.SOURCE,
  DailyBehaveTask.SOURCE,
  GradesTask.SOURCE,
  GroupsTask.SOURCE,
  HomeworkTask.SOURCE,
  LessonsCountTask.SOURCE,
  MailCountsTask.SOURCE,
  MailInboxTask.SOURCE,
  MessageBoardTask.SOURCE,
  OutBehaveTask.SOURCE,
  ReleasesTask.SOURCE,
  SchoolActivitiesTask.SOURCE,
  StudentsTask.SOURCE,
  TimetableTask.SOURCE,
  UserDetailsTask.SOURCE,
];

describe('SOURCE_POLICY', () => {
  it('covers every task that writes a sync_run, and nothing else', () => {
    const inPolicy = SOURCE_POLICY.map((p) => p.source).sort();
    expect(inPolicy).toEqual([...ALL_TASK_SOURCES].sort());
  });

  it('omits notifications, which has no writer any more', () => {
    // `NotificationsTask` is deleted: nothing read `NotificationEvent`. An
    // entry here with no writer makes `getAllSourceHealth` emit a permanent
    // `never_synced` row on /more.
    expect(policyForSource('notifications')).toBeUndefined();
  });

  it('has no duplicate source or task keys', () => {
    expect(new Set(SOURCE_POLICY.map((p) => p.source)).size).toBe(SOURCE_POLICY.length);
    expect(new Set(SOURCE_POLICY.map((p) => p.task)).size).toBe(SOURCE_POLICY.length);
  });

  it('never reports a source stale faster than its own schedule can refresh it', () => {
    // The structural reason the two old tables cannot drift apart again.
    // Violating this is what would pin the app-wide FreshnessBar to amber.
    for (const policy of SOURCE_POLICY) {
      expect(policy.staleThresholdMinutes).toBeGreaterThan(policy.syncTtlMinutes);
    }
  });

  it('keeps timetable and bells in the digest set', () => {
    // ADR-0040: `DigestDismissalService.gateFor` reads `timetable_entry` and
    // `bell_schedule` to find the child's last lesson, and returns OPEN when
    // there are no rows. Demote these to view-only and a household that never
    // opens the timetable tab loses the dismissal gate entirely -- digests
    // would fire at 11:00, mid school day. Nothing else fails if this breaks.
    expect(policyForSource('timetable')?.sets).toContain('digest');
    expect(policyForSource('bells')?.sets).toContain('digest');
  });

  it('keeps the digest inputs in the digest set', () => {
    for (const source of ['homework', 'behavior', 'releases', 'schoolActivities', 'message_board']) {
      expect(policyForSource(source)?.sets).toContain('digest');
    }
  });

  it('puts the dashboard sources in the login set', () => {
    // What /home and /children render, plus achvas, which classifies behaviour
    // rows at sync time rather than at read time.
    const login = sourcesForSet('login').map((p) => p.source).sort();
    expect(login).toEqual(
      ['achvas', 'behavior', 'homework', 'mail_counts', 'mail_inbox', 'students'].sort(),
    );
  });

  it('resolves a policy by task name as well as by source name', () => {
    // Three naming conventions are in play; a map keyed on one and read by the
    // other silently matches nothing.
    expect(policyForTask('mailInbox')?.source).toBe('mail_inbox');
    expect(policyForTask('lessonsCount')?.source).toBe('lessons_count');
    expect(policyForTask('schoolActivities')?.source).toBe('schoolActivities');
  });

  it('derives PER_STUDENT_SOURCES from the same table', () => {
    expect([...PER_STUDENT_SOURCES].sort()).toEqual(
      ['behavior', 'grades', 'groups', 'homework', 'lessons_count', 'message_board', 'timetable'].sort(),
    );
  });

  it('exposes the TTL in milliseconds, and undefined for an unknown source', () => {
    expect(syncTtlMsFor('students')).toBe(24 * 60 * 60_000);
    expect(syncTtlMsFor('no_such_source')).toBeUndefined();
  });

  it('places every source in at least the full set', () => {
    for (const policy of SOURCE_POLICY) {
      expect(policy.sets).toContain('full');
    }
  });

  it('lists only known set names', () => {
    const known: SyncTaskSet[] = ['login', 'digest', 'mail', 'roster', 'full'];
    for (const policy of SOURCE_POLICY) {
      for (const set of policy.sets) {
        expect(known).toContain(set);
      }
    }
  });
});

describe('env overrides', () => {
  const ENV_KEY = 'SYNC_TTL_MAIL_INBOX_MINUTES';
  const HOMEWORK_KEY = 'SYNC_TTL_HOMEWORK_MINUTES';
  const original = process.env[ENV_KEY];
  const originalHomework = process.env[HOMEWORK_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    if (originalHomework === undefined) delete process.env[HOMEWORK_KEY];
    else process.env[HOMEWORK_KEY] = originalHomework;
    jest.resetModules();
  });

  function reload() {
    let mod!: typeof import('./source-policy');
    jest.isolateModules(() => {
      mod = require('./source-policy') as typeof import('./source-policy');
    });
    return mod;
  }

  it('takes a per-source TTL from the environment', () => {
    process.env[ENV_KEY] = '90';
    expect(reload().policyForSource('mail_inbox')?.syncTtlMinutes).toBe(90);
  });

  it('re-derives the reported threshold from an overridden TTL', () => {
    // Otherwise raising the TTL alone would make the source permanently stale.
    process.env[ENV_KEY] = '600';
    expect(reload().policyForSource('mail_inbox')?.staleThresholdMinutes).toBe(1200);
  });

  it('keeps a deliberate threshold when the TTL is LOWERED', () => {
    // The other direction, and the one that bites: homework's 24h reported
    // threshold is deliberate, so re-deriving it from a lowered TTL would
    // report amber after an hour -- an app-wide `FreshnessBar` banner for
    // every household that simply had not synced recently.
    process.env[HOMEWORK_KEY] = '30';
    const policy = reload().policyForSource('homework');
    expect(policy?.syncTtlMinutes).toBe(30);
    expect(policy?.staleThresholdMinutes).toBe(24 * 60);
  });

  it('ignores a value that is not a positive number', () => {
    // A typo must not silently become an aggressive schedule.
    for (const bad of ['nonsense', '0', '-5', '']) {
      process.env[ENV_KEY] = bad;
      expect(reload().policyForSource('mail_inbox')?.syncTtlMinutes).toBe(15);
    }
  });
});
