/**
 * Every `/children/:studentGuid/...` route refuses a foreign child — enumerated
 * from the controller, not listed by hand.
 *
 * This is the test G1 asked for, and the reason it is worth having is narrow
 * and specific: the ownership guard lives in ONE private method
 * (`ChildrenService.getStudentOrThrow`, reached through `requireStudent`), and
 * nothing forces a new per-child method to call it. The existing coverage names
 * the routes one at a time, so route N+1 inherits nothing from it — a reviewer
 * who adds `GET :studentGuid/grades` and forgets one line ships an endpoint
 * that serves any child by guid to any signed-in caller, and every test still
 * passes.
 *
 * So the route list here is read out of Nest's own decorator metadata. A new
 * route with a `:studentGuid` segment is in this suite the moment it is
 * written, whether or not anyone remembers this file. The cross-check against
 * the controller source is the guard on the guard: if the metadata read ever
 * silently returns a partial list, the counts disagree and the suite fails
 * rather than quietly covering nothing.
 *
 * Each route is called twice against a real database:
 *
 *  - as the OTHER parent, with a child only this parent's connection lists —
 *    which must raise `Student not found: <guid>`, the deliberately
 *    indistinguishable-from-absent 404 (a 403 would confirm the guid is real,
 *    and the guids are in URLs);
 *  - as the child's OWN parent, which must NOT raise that error. Without this
 *    half the suite would pass against a service that 404s unconditionally,
 *    and it is what proves the 404 came from the guard rather than from a
 *    missing fixture row.
 *
 * `digest.controller.ts` also accepts a `studentGuid`, but in a query or body
 * rather than a path param, and its own ownership rule is ADR-0026's. It is
 * deliberately out of scope here; this suite is about the path-param surface.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ROUTE_ARGS_METADATA, PATH_METADATA, METHOD_METADATA } from '../../backend/node_modules/@nestjs/common/constants';
import { Test, TestingModule } from '../../backend/node_modules/@nestjs/testing';
import { ConfigModule } from '../../backend/node_modules/@nestjs/config';
import { PrismaClient } from '../../backend/node_modules/@prisma/client';

import { ChildrenModule } from '../../backend/src/children/children.module';
import { ChildrenController } from '../../backend/src/children/children.controller';
import { MashovHttpClient } from '../../backend/src/session/mashov-http.client';

const SEMEL = 667788;
const YEAR = 2027;
const USER_A = 'rg-user-a';
const USER_B = 'rg-user-b';
const CONN_A = 'rg-conn-a';
const CONN_B = 'rg-conn-b';
const CHILD_A = 'rg-guid-a';
const CHILD_B = 'rg-guid-b';
const ALL_GUIDS = [CHILD_A, CHILD_B];

/** Nest's `@Param`/`@Body`/`@Req` metadata for one handler. */
interface RouteArg {
  index: number;
  data?: unknown;
}

const RouteParam = {
  REQUEST: 0,
  RESPONSE: 1,
  BODY: 3,
  QUERY: 4,
  PARAM: 5,
} as const;

interface GuardedRoute {
  handler: string;
  method: string;
  routePath: string;
}

const HTTP_METHOD_NAMES = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'ALL',
  'OPTIONS',
  'HEAD',
  'SEARCH',
];

/**
 * Every handler on the controller whose route path carries a `:studentGuid`
 * segment, read from the decorators themselves.
 */
function enumerateGuardedRoutes(): GuardedRoute[] {
  const prototype = ChildrenController.prototype as unknown as Record<string, unknown>;
  const routes: GuardedRoute[] = [];

  for (const handler of Object.getOwnPropertyNames(prototype)) {
    if (handler === 'constructor') continue;
    const fn = prototype[handler];
    if (typeof fn !== 'function') continue;

    const routePath: unknown = Reflect.getMetadata(PATH_METADATA, fn);
    const methodIndex: unknown = Reflect.getMetadata(METHOD_METADATA, fn);
    if (typeof routePath !== 'string' || typeof methodIndex !== 'number') continue;
    if (!routePath.includes(':studentGuid')) continue;

    routes.push({
      handler,
      method: HTTP_METHOD_NAMES[methodIndex] ?? String(methodIndex),
      routePath,
    });
  }

  return routes.sort((a, b) => a.handler.localeCompare(b.handler));
}

/**
 * The same count, taken from the source text.
 *
 * Two independent reads of one fact: if a Nest upgrade changes where route
 * metadata lives, this disagrees with the metadata read instead of letting the
 * suite pass over an empty list.
 */
function routePathsInSource(): string[] {
  const source = fs.readFileSync(
    path.join(__dirname, '../../backend/src/children/children.controller.ts'),
    'utf8',
  );
  const matches = source.matchAll(/@(?:Get|Post|Put|Delete|Patch|All)\(\s*'([^']*:studentGuid[^']*)'/g);
  return [...matches].map((match) => match[1]).sort();
}

/** A response object good enough for the `@Res({ passthrough: true })` handlers. */
function fakeResponse(): unknown {
  const response = {
    setHeader: () => response,
    status: () => response,
    send: () => response,
    json: () => response,
  };
  return response;
}

/**
 * One body that satisfies every per-child handler.
 *
 * The DTO pipes do not run on a direct handler call, and they are not what is
 * under test: the guard runs before the body is read, so the only requirement
 * is that the OWNER call gets far enough to fail for some other reason, or not
 * fail at all.
 */
function bodyFor(studentGuid: string): Record<string, unknown> {
  return {
    isNew: true,
    isArchived: true,
    homeworkIds: [],
    behaviorIds: [],
    studentGuid,
    releaseDate: '2026-11-18',
    startHour: '08:00',
    remark: 'בדיקה',
  };
}

function argumentsFor(handler: string, studentGuid: string, userId: string): unknown[] {
  const metadata =
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, ChildrenController, handler) as
      | Record<string, RouteArg>
      | undefined) ?? {};

  const args: unknown[] = [];
  for (const [key, arg] of Object.entries(metadata)) {
    const paramType = Number(key.split(':')[0]);
    switch (paramType) {
      case RouteParam.REQUEST:
        args[arg.index] = { user: { userId } };
        break;
      case RouteParam.RESPONSE:
        args[arg.index] = fakeResponse();
        break;
      case RouteParam.BODY:
        args[arg.index] = bodyFor(studentGuid);
        break;
      case RouteParam.PARAM:
        // Every other path param is an upstream id; `1` is a legal shape for
        // all of them and names nothing in the fixture, which is fine -- the
        // guard is reached before any of them is looked up.
        args[arg.index] = arg.data === 'studentGuid' ? studentGuid : '1';
        break;
      case RouteParam.QUERY:
        // `@Query()` with no key hands the handler the whole query object and
        // reads fields off it, so `undefined` throws a TypeError before the
        // guard is ever reached -- which is exactly how the two list routes
        // first appeared to be unguarded. `@Query('page')` takes the field.
        args[arg.index] = arg.data === undefined ? {} : undefined;
        break;
      default:
        args[arg.index] = undefined;
    }
  }

  // A handler whose metadata has gaps would otherwise silently receive
  // `undefined` for the guid and 404 for the wrong reason.
  if (!args.includes(studentGuid) && !args.some((arg) => arg === studentGuid)) {
    throw new Error(`No :studentGuid argument resolved for handler ${handler}`);
  }

  return args;
}

const guardMessage = (studentGuid: string): string => `Student not found: ${studentGuid}`;

/** What the call did, in one line, for a readable failure. */
function describeOutcome(rejection: unknown, studentGuid: string): string {
  if (rejection === undefined) return 'resolved without raising';
  if (isGuardRejection(rejection, studentGuid)) return 'the guard 404';
  const name = (rejection as { name?: string }).name ?? typeof rejection;
  const message = (rejection as { message?: string }).message ?? String(rejection);
  return `${name}: ${message}`;
}

/** The guard's exact 404, told apart from every other NotFoundException. */
function isGuardRejection(error: unknown, studentGuid: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const response = (error as { response?: unknown }).response;
  const envelope =
    response && typeof response === 'object'
      ? ((response as { error?: { code?: string; message?: string } }).error ?? null)
      : null;
  if (envelope) {
    return envelope.code === 'NOT_FOUND' && envelope.message === guardMessage(studentGuid);
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message === guardMessage(studentGuid);
}

describe('children routes refuse a foreign child', () => {
  let app: TestingModule;
  let controller: ChildrenController;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();

    app = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), ChildrenModule],
    })
      .overrideProvider(MashovHttpClient)
      // Nothing here should reach upstream: the guard rejects before any
      // request, and the owner calls are asserted only on what they do NOT
      // throw. A client that answers emptily keeps an accidental call from
      // turning into a network timeout.
      .useValue({
        get: jest.fn().mockResolvedValue({}),
        put: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        getForTarget: jest.fn().mockResolvedValue({}),
        getResponseForTarget: jest.fn().mockResolvedValue({ data: Buffer.from(''), headers: {} }),
        putForTarget: jest.fn().mockResolvedValue({}),
        deleteForTarget: jest.fn().mockResolvedValue({}),
      })
      .compile();

    controller = app.get(ChildrenController);
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.studentConnection.deleteMany({ where: { studentGuid: { in: ALL_GUIDS } } });
    await prisma.student.deleteMany({ where: { studentGuid: { in: ALL_GUIDS } } });
    await prisma.householdConnection.deleteMany({ where: { schoolCode: SEMEL } });
    await prisma.appUser.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
  }

  /** Two parents at one school, one child each, listed by its own parent only. */
  async function seed(): Promise<void> {
    await cleanup();

    for (const [id, username] of [
      [USER_A, 'route-guard-a'],
      [USER_B, 'route-guard-b'],
    ]) {
      await prisma.appUser.create({
        data: {
          id,
          mashovUserId: `upstream-${id}`,
          username,
          displayName: username,
          semel: SEMEL,
        },
      });
    }

    for (const [id, userId, username] of [
      [CONN_A, USER_A, 'route-guard-a'],
      [CONN_B, USER_B, 'route-guard-b'],
    ]) {
      await prisma.householdConnection.create({
        data: {
          id,
          userId,
          username,
          schoolCode: SEMEL,
          schoolYear: YEAR,
          encryptedPassword: 'enc',
          schoolName: 'בית ספר',
          active: true,
        },
      });
    }

    await prisma.student.createMany({
      data: [
        [CHILD_A, CONN_A],
        [CHILD_B, CONN_B],
      ].map(([studentGuid, stamp]) => ({
        studentGuid,
        privateName: 'ילד',
        familyName: 'כלשהו',
        fullName: `ילד ${studentGuid}`,
        classCode: 'ז',
        classNum: 1,
        gender: 'M',
        isActive: true,
        householdConnectionId: stamp,
      })),
    });

    await prisma.studentConnection.createMany({
      data: [
        { studentGuid: CHILD_A, householdConnectionId: CONN_A, lastSeenInRosterAt: new Date() },
        { studentGuid: CHILD_B, householdConnectionId: CONN_B, lastSeenInRosterAt: new Date() },
      ],
    });
  }

  const routes = enumerateGuardedRoutes();

  it('enumerates every per-child route from the controller itself', () => {
    const fromSource = routePathsInSource();

    expect(routes.length).toBeGreaterThan(0);
    expect(routes.map((route) => route.routePath).sort()).toEqual(fromSource);
  });

  describe.each(routes.map((route) => [`${route.method} /children/${route.routePath}`, route]))(
    '%s',
    (_label, route) => {
      const { handler } = route as GuardedRoute;

      it("404s with the not-found message for the other parent's child", async () => {
        const call = (controller as unknown as Record<string, (...args: unknown[]) => unknown>)[
          handler
        ].bind(controller);

        let rejection: unknown;
        try {
          await call(...argumentsFor(handler, CHILD_A, USER_B));
        } catch (error) {
          rejection = error;
        }

        // Compared as a string so a failure names what the route did instead
        // -- "resolved" for an unguarded route, or the error it raised for a
        // route that threw for some other reason.
        expect(describeOutcome(rejection, CHILD_A)).toBe('the guard 404');
      });

      it("does not raise that 404 for the child's own parent", async () => {
        const call = (controller as unknown as Record<string, (...args: unknown[]) => unknown>)[
          handler
        ].bind(controller);

        let rejection: unknown;
        try {
          await call(...argumentsFor(handler, CHILD_A, USER_A));
        } catch (error) {
          rejection = error;
        }

        expect(isGuardRejection(rejection, CHILD_A)).toBe(false);
      });
    },
  );
});
