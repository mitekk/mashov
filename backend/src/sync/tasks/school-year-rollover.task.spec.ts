import { PrismaService } from '../../prisma/prisma.service';
import { SchoolYearService } from '../../common/school-year/school-year.service';
import { MashovSessionService } from '../../session/mashov-session.service';
import { StudentsTask } from './students.task';
import { SchoolYearRolloverTask } from './school-year-rollover.task';

const CONNECTION = {
  id: 'conn-1',
  schoolCode: 1234,
  schoolYear: 2026,
  username: 'parent',
  active: true,
};

describe('SchoolYearRolloverTask', () => {
  let task: SchoolYearRolloverTask;
  let prisma: { householdConnection: { findMany: jest.Mock } };
  let schoolYear: { resolveForSchool: jest.Mock };
  let session: { refreshRosterForConnection: jest.Mock };
  let studentsTask: { execute: jest.Mock };
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    prisma = {
      householdConnection: { findMany: jest.fn().mockResolvedValue([CONNECTION]) },
    };
    schoolYear = {
      resolveForSchool: jest
        .fn()
        .mockResolvedValue({ year: 2027, source: 'schools-api' }),
    };
    session = {
      refreshRosterForConnection: jest.fn().mockResolvedValue({
        created: 0,
        updated: 1,
        deactivated: 0,
        year: 2027,
      }),
    };
    studentsTask = { execute: jest.fn().mockResolvedValue(undefined) };

    task = new SchoolYearRolloverTask(
      prisma as unknown as PrismaService,
      schoolYear as unknown as SchoolYearService,
      session as unknown as MashovSessionService,
      studentsTask as unknown as StudentsTask,
    );
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.useRealTimers();
  });

  it('advances a connection to the year Mashov confirms', async () => {
    await task.run();

    expect(session.refreshRosterForConnection).toHaveBeenCalledWith('conn-1', 2027);
    expect(studentsTask.execute).toHaveBeenCalledWith({ connectionId: 'conn-1' });
  });

  it('leaves a connection alone when the resolved year is not newer', async () => {
    schoolYear.resolveForSchool.mockResolvedValue({ year: 2026, source: 'calendar' });

    await task.run();

    expect(session.refreshRosterForConnection).not.toHaveBeenCalled();
  });

  it('does not block application bootstrap on the upstream run', async () => {
    // Nest awaits onApplicationBootstrap before app.listen(), so a slow or
    // unreachable Mashov here delays /health past the container healthcheck
    // window and blocks everything that depends_on the backend.
    let settled = false;
    let pending: NodeJS.Timeout | undefined;
    prisma.householdConnection.findMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending = setTimeout(() => {
            settled = true;
            resolve([]);
          }, 30_000);
          pending.unref();
        }),
    );

    task.onApplicationBootstrap();
    // One macrotask is enough for an awaited hook to have reached the upstream
    // call; a backgrounded one has not blocked anything.
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    if (pending) clearTimeout(pending);
  });

  it('swallows a rollover failure rather than crashing the scheduler', async () => {
    session.refreshRosterForConnection.mockRejectedValue(new Error('upstream down'));

    await expect(task.run()).resolves.toBeUndefined();
  });
});
