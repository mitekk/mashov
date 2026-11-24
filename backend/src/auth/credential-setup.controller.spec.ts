import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { CredentialSetupController } from './credential-setup.controller';
import { CredentialSetupService } from './credential-setup.service';

const mockSetup = { setCredentials: jest.fn() };

const SEMEL = 482273;
const USERNAME = '303977367';

function res(): Response & { cookies: Array<[string, string, Record<string, unknown>]> } {
  const cookies: Array<[string, string, Record<string, unknown>]> = [];
  return {
    cookies,
    cookie: (name: string, value: string, opts: Record<string, unknown>) => {
      cookies.push([name, value, opts]);
    },
  } as unknown as Response & { cookies: typeof cookies };
}

const req = { headers: {}, ip: '203.0.113.9' } as unknown as Request;

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
 * The HTTP edge of forced credential setup and passwordless sign-in, which had
 * no spec at all.
 *
 * This is the controller that changes a third party's Mashov password
 * (ADR-0042 §9) and the one that mints sessions for both flows, and all of its
 * validation is hand-rolled: `Number()` coercion, a `str()` helper that
 * swallows non-strings, trimming, and falsy-checks that turn `''` into
 * `undefined` on the optional fields. Every one of those is ordinary code that
 * can be wrong.
 */
describe('CredentialSetupController', () => {
  let controller: CredentialSetupController;
  let config: Record<string, string | undefined>;

  beforeEach(async () => {
    jest.clearAllMocks();
    config = {};
    mockSetup.setCredentials.mockResolvedValue({ sessionToken: 'tok', isFirstLogin: true });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CredentialSetupController],
      providers: [
        { provide: CredentialSetupService, useValue: mockSetup },
        { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
      ],
    }).compile();

    controller = module.get(CredentialSetupController);
  });

  function setCredentials(body: Record<string, unknown> = {}, response = res()) {
    return controller.setCredentials(
      { semel: SEMEL, username: USERNAME, password: 'oldpw1', ...body } as never,
      req,
      response,
    );
  }

  describe('POST /auth/credentials', () => {
    it('passes the change through and mints a session', async () => {
      const response = res();
      await expect(setCredentials({ newPassword: 'secret1' }, response)).resolves.toEqual({
        ok: true,
        isFirstLogin: true,
      });
      expect(response.cookies[0][0]).toBe('mashov_session');
    });

    it('requires semel, username and password together', async () => {
      for (const body of [
        { semel: 0 },
        { semel: -1 },
        { semel: 'abc' },
        { semel: null },
        { semel: NaN },
        { username: '' },
        { username: '   ' },
        { username: 12345 },
        { password: '' },
        { password: null },
      ]) {
        expect(await thrown(() => setCredentials(body))).toEqual({
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }
      expect(mockSetup.setCredentials).not.toHaveBeenCalled();
    });

    it('turns a blank optional field into undefined, not an empty change', async () => {
      // `newPassword: ''` reaching the service would look like a request to set
      // an empty password rather than a request to change nothing.
      await setCredentials({ newPassword: '', newUsername: '', challengeId: '' });
      expect(mockSetup.setCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          newPassword: undefined,
          newUsername: undefined,
          challengeId: undefined,
        }),
        expect.any(String),
      );
    });

    it('drops a non-string optional field rather than coercing it', async () => {
      await setCredentials({ newPassword: 12345, newUsername: {} });
      const sent = mockSetup.setCredentials.mock.calls[0][0];
      // `str()` returns '' for a non-string, so these must not arrive as
      // '12345' or '[object Object]' and become someone's real password.
      expect(sent.newPassword).toBe('');
      expect(sent.newUsername).toBe('');
    });

    it('trims the username but never the password', async () => {
      // A password with deliberate leading or trailing spaces is still the
      // parent's password; silently trimming it locks them out.
      await setCredentials({ username: '  303977367  ', password: '  pw  ' });
      expect(mockSetup.setCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ username: USERNAME, password: '  pw  ' }),
        expect.any(String),
      );
    });

    it('sets no cookie when validation fails', async () => {
      const response = res();
      await thrown(() => setCredentials({ password: '' }, response));
      expect(response.cookies).toHaveLength(0);
    });
  });

  it('never answers 401 on any route or validation path', async () => {
    // `apiFetch` hard-redirects on any 401 whose code is not
    // INVALID_CREDENTIALS, which would throw the parent off a half-filled form.
    const cases: Array<() => Promise<unknown>> = [
      () => setCredentials({ password: '' }),
      () => setCredentials({ semel: 'x' }),
    ];
    for (const run of cases) {
      expect((await thrown(run)).status).not.toBe(401);
    }
  });
});
