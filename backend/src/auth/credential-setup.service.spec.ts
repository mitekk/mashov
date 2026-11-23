import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import axios, { AxiosError, CanceledError } from 'axios';
import { Prisma } from '@prisma/client';
import { CredentialSetupService } from './credential-setup.service';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { EncryptionService } from '../session/encryption.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { MashovRecoveryService } from '../common/mashov-login/mashov-recovery.service';

const mockUpstream = {
  changePassword: jest.fn(),
  changeUsername: jest.fn(),
};

const mockAuth = { persistSessionFromLogin: jest.fn() };
const mockPrisma = { householdConnection: { findUnique: jest.fn() } };
const mockSchoolYear = { resolveForSchool: jest.fn() };

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
};

const mockEncryption = {
  hashKey: jest.fn().mockReturnValue(Buffer.from('test-identity-hash-key')),
};

const SEMEL = 482273;
const USERNAME = '303977367';
const IP = '203.0.113.11';

function okResult() {
  return {
    data: { credential: { userId: 'u1' } },
    newUniqueId: 'uniq-1',
    csrfToken: 'csrf-1',
    devicePass: 'dp-1',
  };
}

function reasonError(reason: string, status = 403): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: {},
    headers: { reason },
  } as unknown as AxiosError['response'];
  return err;
}

/**
 * A Mashov answer with no `Reason` header. The JSON content type matters: it is
 * what marks the response as having come from Mashov's API rather than from a
 * proxy ACL page or a WAF, and only the former is evidence about the input.
 */
function bareError(status: number): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: {},
    headers: { 'content-type': 'application/json' },
  } as unknown as AxiosError['response'];
  return err;
}

async function thrown(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    const http = err as HttpException;
    return {
      status: http.getStatus(),
      code: (http.getResponse() as { error: { code: string } }).error.code,
    };
  }
  throw new Error('expected a rejection, got a resolution');
}

/**
 * The forced-credential-change path: Mashov answered `403 Reason: ChangePass`
 * or `SetUsernameAndPass`, so the parent's password is CORRECT and they still
 * cannot get in until they replace it. Before this surface existed they were
 * told their password was wrong and had nowhere to go but Mashov's own site.
 */
describe('CredentialSetupService', () => {
  let service: CredentialSetupService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(axios, 'isCancel').mockReturnValue(false);
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    mockRedis.incr.mockResolvedValue(1);
    mockEncryption.hashKey.mockReturnValue(Buffer.from('test-identity-hash-key'));
    mockUpstream.changePassword.mockResolvedValue(okResult());
    mockUpstream.changeUsername.mockResolvedValue(okResult());
    mockAuth.persistSessionFromLogin.mockResolvedValue({
      sessionToken: 'tok',
      isFirstLogin: false,
    });
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockSchoolYear.resolveForSchool.mockResolvedValue({ year: 2027, source: 'calendar' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialSetupService,
        { provide: AuthService, useValue: mockAuth },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SchoolYearService, useValue: mockSchoolYear },
        { provide: RedisService, useValue: mockRedis },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: MashovRecoveryService, useValue: mockUpstream },
      ],
    }).compile();

    service = module.get(CredentialSetupService);
  });

  function run(overrides: Record<string, unknown> = {}) {
    return service.setCredentials(
      {
        semel: SEMEL,
        username: USERNAME,
        password: 'oldpw1',
        newPassword: 'secret1',
        ...overrides,
      },
      IP,
    );
  }

  it('changes the password and mints a session', async () => {
    await expect(run()).resolves.toEqual({ sessionToken: 'tok', isFirstLogin: false });
    expect(mockUpstream.changePassword).toHaveBeenCalledWith(
      expect.objectContaining({ newPassword: 'secret1' }),
    );
  });

  it('stores the NEW password, not the old one', async () => {
    // The whole point: after this the stored credential has to be the one that
    // works, or every background sync fails from the next cron onwards.
    await run();
    expect(mockAuth.persistSessionFromLogin).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'secret1' }),
    );
  });

  it('echoes the challenge id through to Mashov', async () => {
    await run({ challengeId: 'ch-7' });
    expect(mockUpstream.changePassword).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId: 'ch-7' }),
    );
  });

  it('rejects a weak password before any upstream call', async () => {
    expect(await thrown(() => run({ newPassword: 'abc' }))).toMatchObject({
      status: 422,
      code: 'WEAK_PASSWORD',
    });
    expect(mockUpstream.changePassword).not.toHaveBeenCalled();
  });

  it('refuses a new password containing the username', async () => {
    // The extra rule Mashov's own change-password dialog enforces.
    expect(
      await thrown(() => run({ newPassword: `a1${USERNAME}` })),
    ).toMatchObject({ status: 422, code: 'WEAK_PASSWORD' });
  });

  it('checks the new password against the NEW username when both change', async () => {
    expect(
      await thrown(() => run({ newUsername: 'avocado', newPassword: 'avocado1' })),
    ).toMatchObject({ status: 422, code: 'WEAK_PASSWORD' });
  });

  it('refuses a request that changes nothing', async () => {
    expect(
      await thrown(() => run({ newPassword: undefined })),
    ).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  describe('username change', () => {
    it('sets the username on its own when no password is given', async () => {
      await run({ newPassword: undefined, newUsername: 'avocado' });

      expect(mockUpstream.changeUsername).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'avocado' }),
      );
      expect(mockUpstream.changePassword).not.toHaveBeenCalled();
    });

    it('sets the username FIRST, then the password', async () => {
      // SetUsernameAndPass wants both. The password change has to be posted
      // against the new username, or Mashov is being asked to change the
      // password of an account that no longer has that name.
      const order: string[] = [];
      mockUpstream.changeUsername.mockImplementation(async () => {
        order.push('username');
        return okResult();
      });
      mockUpstream.changePassword.mockImplementation(async () => {
        order.push('password');
        return okResult();
      });

      await run({ newUsername: 'avocado', newPassword: 'secret1' });

      expect(order).toEqual(['username', 'password']);
    });

    it('posts the password change against the new username', async () => {
      await run({ newUsername: 'avocado', newPassword: 'secret1' });

      expect(mockUpstream.changePassword.mock.calls[0][0].loginData).toMatchObject({
        username: 'avocado',
      });
    });

    it('persists the session under the new username', async () => {
      await run({ newUsername: 'avocado', newPassword: 'secret1' });

      expect(mockAuth.persistSessionFromLogin).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'avocado' }),
      );
    });

    it('keeps the old password when only the username changed', async () => {
      await run({ newPassword: undefined, newUsername: 'avocado' });

      expect(mockAuth.persistSessionFromLogin).toHaveBeenCalledWith(
        expect.objectContaining({ password: 'oldpw1' }),
      );
    });
  });

  describe('upstream failures', () => {
    const CASES: Array<[string, number, string]> = [
      ['UsernameExists', 409, 'USERNAME_TAKEN'],
      ['UsernameLocked', 429, 'USERNAME_LOCKED'],
      ['MfaRequired', 400, 'MFA_REQUIRED'],
      ['UserSuspended', 422, 'CAPTCHA_REQUIRED'],
    ];

    for (const [reason, status, code] of CASES) {
      it(`maps ${reason} to ${status} ${code}`, async () => {
        mockUpstream.changeUsername.mockRejectedValue(reasonError(reason));
        expect(
          await thrown(() => run({ newPassword: undefined, newUsername: 'avocado' })),
        ).toEqual({ status, code });
      });
    }

    it('reports a rejected current password as invalid credentials, not as weak', async () => {
      mockUpstream.changePassword.mockRejectedValue(bareError(401));
      expect(await thrown(() => run())).toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
    });

    it('answers 502 when Mashov never responded', async () => {
      jest.spyOn(axios, 'isCancel').mockReturnValue(true);
      mockUpstream.changePassword.mockRejectedValue(new CanceledError('aborted'));
      expect(await thrown(() => run())).toEqual({
        status: 502,
        code: 'UPSTREAM_ERROR',
      });
    });

    it('mints no session when the change did not land', async () => {
      mockUpstream.changePassword.mockRejectedValue(reasonError('MfaRequired'));
      await thrown(() => run());
      expect(mockAuth.persistSessionFromLogin).not.toHaveBeenCalled();
    });
  });

  it('refuses to mint a session for a payload with no user id', async () => {
    mockUpstream.changePassword.mockResolvedValue({
      data: {},
      newUniqueId: undefined,
      csrfToken: undefined,
      devicePass: undefined,
    });

    expect(await thrown(() => run())).toMatchObject({ status: 400 });
    expect(mockAuth.persistSessionFromLogin).not.toHaveBeenCalled();
  });
});

describe('CredentialSetupService review fixes', () => {
  let service: CredentialSetupService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(axios, 'isCancel').mockReturnValue(false);
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    mockRedis.incr.mockResolvedValue(1);
    mockEncryption.hashKey.mockReturnValue(Buffer.from('test-identity-hash-key'));
    mockUpstream.changePassword.mockResolvedValue(okResult());
    mockUpstream.changeUsername.mockResolvedValue(okResult());
    mockAuth.persistSessionFromLogin.mockResolvedValue({
      sessionToken: 'tok',
      isFirstLogin: false,
    });
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockSchoolYear.resolveForSchool.mockResolvedValue({ year: 2027, source: 'calendar' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialSetupService,
        { provide: AuthService, useValue: mockAuth },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: SchoolYearService, useValue: mockSchoolYear },
        { provide: MashovRecoveryService, useValue: mockUpstream },
      ],
    }).compile();

    service = module.get(CredentialSetupService);
  });

  function run(overrides: Record<string, unknown> = {}) {
    return service.setCredentials(
      {
        semel: SEMEL,
        username: USERNAME,
        password: 'oldpw1',
        newPassword: 'secret1',
        ...overrides,
      },
      IP,
    );
  }

  it('claims the password WAS proven, because Mashov checked it', async () => {
    await run();
    expect(mockAuth.persistSessionFromLogin).toHaveBeenCalledWith(
      expect.objectContaining({ credentialProven: true }),
    );
  });

  describe('rate limits', () => {
    it('refuses once the per-IP budget is gone, before any upstream call', async () => {
      // Without this the route is an unauthenticated password oracle that
      // routes around `ratelimit:login` entirely: a wrong current password
      // answers 400, a right one answers with a session cookie.
      mockRedis.incr.mockResolvedValue(99);

      expect(await thrown(() => run())).toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
      });
      expect(mockUpstream.changePassword).not.toHaveBeenCalled();
      expect(mockUpstream.changeUsername).not.toHaveBeenCalled();
    });

    it('limits per identity as well as per IP', async () => {
      const keys: string[] = [];
      mockRedis.incr.mockImplementation((key: string) => {
        keys.push(key);
        return Promise.resolve(1);
      });

      await run();

      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(`ratelimit:credentials:${IP}`);
      expect(keys[1]).toMatch(
        new RegExp(`^ratelimit:credentials:id:${SEMEL}:[0-9a-f]{64}$`),
      );
      expect(keys.join(' ')).not.toContain(USERNAME);
    });
  });

  it('answers 502, not a bad current password, for a proxy ACL 403', async () => {
    const err = new AxiosError('Forbidden', 'ERR_BAD_REQUEST');
    err.response = {
      status: 403,
      data: '<html>denied</html>',
      headers: { 'content-type': 'text/html' },
    } as unknown as AxiosError['response'];
    mockUpstream.changePassword.mockRejectedValue(err);

    expect(await thrown(() => run())).toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    });
  });

  it('carries the challenge id through on MfaRequired, so the next step has a handle', async () => {
    const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
    err.response = {
      status: 403,
      data: { challengeId: 'ch-9' },
      headers: { reason: 'MfaRequired' },
    } as unknown as AxiosError['response'];
    mockUpstream.changePassword.mockRejectedValue(err);

    let thrownErr: HttpException | undefined;
    try {
      await run();
    } catch (caught) {
      thrownErr = caught as HttpException;
    }

    const body = thrownErr?.getResponse() as { error: { challengeId?: string } };
    expect(body.error.challengeId).toBe('ch-9');
  });
});

describe('CredentialSetupService username collisions', () => {
  let service: CredentialSetupService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(axios, 'isCancel').mockReturnValue(false);
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    mockRedis.incr.mockResolvedValue(1);
    mockEncryption.hashKey.mockReturnValue(Buffer.from('test-identity-hash-key'));
    mockUpstream.changePassword.mockResolvedValue(okResult());
    mockUpstream.changeUsername.mockResolvedValue(okResult());
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockSchoolYear.resolveForSchool.mockResolvedValue({ year: 2027, source: 'calendar' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialSetupService,
        { provide: AuthService, useValue: mockAuth },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: SchoolYearService, useValue: mockSchoolYear },
        { provide: MashovRecoveryService, useValue: mockUpstream },
      ],
    }).compile();

    service = module.get(CredentialSetupService);
  });

  it('answers 409 USERNAME_TAKEN when our own unique key collides', async () => {
    // This is the one path that deliberately CHANGES the username, so a
    // collision on `@@unique([schoolCode, username])` is foreseeable rather
    // than a race -- an orphan row from an earlier unlink, or the other parent
    // at that school. Mashov accepted the rename; our write is what refused.
    // A raw P2002 reaching the filter is a 500, which tells the parent nothing.
    mockAuth.persistSessionFromLogin.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['schoolCode', 'username'] },
      }),
    );

    let thrownErr: HttpException | undefined;
    try {
      await service.setCredentials(
        {
          semel: SEMEL,
          username: USERNAME,
          password: 'oldpw1',
          newUsername: 'avocado',
        },
        IP,
      );
    } catch (err) {
      thrownErr = err as HttpException;
    }

    expect(thrownErr?.getStatus()).toBe(409);
    expect((thrownErr?.getResponse() as { error: { code: string } }).error.code).toBe(
      'USERNAME_TAKEN',
    );
  });

  it('lets an unrelated database failure through rather than mislabelling it', async () => {
    const boom = new Error('connection pool exhausted');
    mockAuth.persistSessionFromLogin.mockRejectedValue(boom);

    await expect(
      service.setCredentials(
        {
          semel: SEMEL,
          username: USERNAME,
          password: 'oldpw1',
          newPassword: 'secret1',
        },
        IP,
      ),
    ).rejects.toThrow('connection pool exhausted');
  });
});
