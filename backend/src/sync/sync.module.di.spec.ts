import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ChildrenModule } from '../children/children.module';
import { SettingsModule } from '../settings/settings.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ChildrenService } from '../children/children.service';
import { SettingsService } from '../settings/settings.service';

/**
 * Compiles the real Nest dependency graph for the modules that inject out of
 * `SyncModule`.
 *
 * This exists because of a bug the whole unit suite missed. `ChildrenService`
 * and `SettingsService` gained injected sync tasks for read-path freshening,
 * and `SyncModule` listed those tasks as *providers* but not as *exports*.
 * Nothing caught it: `tsc` sees a constructor it can type, and every unit spec
 * constructs these services positionally with hand-made doubles, so no test
 * ever asked Nest to resolve them. Only booting the app — or the Docker
 * integration suite, minutes later — failed.
 *
 * Prisma and Redis are stubbed so this needs no database and stays in the fast
 * suite, which is the point: a missing export should cost seconds to find.
 */
describe('SyncModule exports what its consumers inject', () => {
  async function compile(module: unknown) {
    return Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), module as never],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({})
      .compile();
  }

  it('resolves ChildrenService, which injects the slow-source tasks', async () => {
    // timetable, bells, groups, lessonsCount, messageBoard + SyncOnReadService
    const moduleRef = await compile(ChildrenModule);
    expect(moduleRef.get(ChildrenService)).toBeDefined();
    await moduleRef.close();
  });

  it('resolves SettingsService, which injects the user-details task', async () => {
    const moduleRef = await compile(SettingsModule);
    expect(moduleRef.get(SettingsService)).toBeDefined();
    await moduleRef.close();
  });
});
