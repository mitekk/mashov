import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';

const mockMfa = { sendCode: jest.fn(), createSession: jest.fn() };

const CHALLENGE = 'ch-11111111-1111-4111-8111-111111111111';
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
 * The HTTP edge of the MFA challenge, which had no spec at all.
 *
 * The validation here is hand-rolled rather than class-validator, so every
 * branch is ordinary code that can be wrong: `Number()` coercion, trimming,
 * and four separate required-field checks whose ORDER decides which message a
 * parent sees. This is also where the session cookie is minted, and the rule
 * that no route on this surface may answer 401 lives here rather than in the
 * service.
 */
describe('MfaController', () => {
  let controller: MfaController;
  let config: Record<string, string | undefined>;

  beforeEach(async () => {
    jest.clearAllMocks();
    config = {};
    mockMfa.sendCode.mockResolvedValue({ ok: true });
    mockMfa.createSession.mockResolvedValue({ sessionToken: 'tok', isFirstLogin: false });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MfaController],
      providers: [
        { provide: MfaService, useValue: mockMfa },
        { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
      ],
    }).compile();

    controller = module.get(MfaController);
  });

  function session(body: Record<string, unknown> = {}, response = res()) {
    return controller.createSession(
      CHALLENGE,
      {
        semel: SEMEL,
        username: USERNAME,
        password: 'pw',
        code: '123456',
        ...body,
      } as never,
      req,
      response,
    );
  }

  describe('sendCode', () => {
    it('asks for a code on the named channel', async () => {
      await expect(controller.sendCode(CHALLENGE, { method: 'sms' }, req)).resolves.toEqual({
        ok: true,
      });
      expect(mockMfa.sendCode).toHaveBeenCalledWith(CHALLENGE, 'sms', expect.any(String));
    });

    it('refuses a blank challenge id rather than passing it on', async () => {
      // `/mfa-challenges//code` would otherwise reach the service and spend a
      // rate-limit token on a key of `ratelimit:mfa:challenge:`.
      for (const id of ['', '   ']) {
        expect(await thrown(() => controller.sendCode(id, { method: 'email' }, req))).toEqual({
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }
      expect(mockMfa.sendCode).not.toHaveBeenCalled();
    });

    it('refuses a channel Mashov does not have', async () => {
      for (const method of ['carrier-pigeon', '', undefined, null, 'EMAIL', 1]) {
        expect(
          await thrown(() => controller.sendCode(CHALLENGE, { method } as never, req)),
        ).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
      }
      expect(mockMfa.sendCode).not.toHaveBeenCalled();
    });

    it('refuses a missing body without throwing a TypeError', async () => {
      expect(
        await thrown(() => controller.sendCode(CHALLENGE, undefined as never, req)),
      ).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    });
  });

  describe('createSession', () => {
    it('mints a session and sets the cookie', async () => {
      const response = res();
      await expect(session({}, response)).resolves.toEqual({
        ok: true,
        isFirstLogin: false,
      });

      const [[name, value, opts]] = response.cookies;
      expect(name).toBe('mashov_session');
      expect(value).toBe('tok');
      // Exactly the options `AuthController.login` uses, so an MFA sign-in and
      // a password sign-in produce the same session.
      expect(opts).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/' });
    });

    it('defaults to a secure cookie and a 30-day life', async () => {
      const response = res();
      await session({}, response);
      expect(response.cookies[0][2]).toMatchObject({
        secure: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
    });

    it('drops Secure only when explicitly told to, for local HTTP', async () => {
      // Any other value, including a typo, must keep the cookie secure.
      config.SESSION_SECURE_COOKIE = 'false';
      const open = res();
      await session({}, open);
      expect(open.cookies[0][2]).toMatchObject({ secure: false });

      config.SESSION_SECURE_COOKIE = 'FALSE';
      const stillSecure = res();
      await session({}, stillSecure);
      expect(stillSecure.cookies[0][2]).toMatchObject({ secure: true });
    });

    it('honours a configured session lifetime', async () => {
      config.SESSION_LIFETIME_DAYS = '7';
      const response = res();
      await session({}, response);
      expect(response.cookies[0][2]).toMatchObject({
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
    });

    it('requires a password, and says so', async () => {
      // Deliberate, and the comment at the call site explains why: Mashov's
      // own verify route rejects a password, but our sync crons re-login by
      // decrypting the stored credential, so an MFA sign-in carrying none
      // would mint a working session with no background sync at all.
      expect(await thrown(() => session({ password: '' }))).toEqual({
        status: 400,
        code: 'VALIDATION_ERROR',
      });
      expect(mockMfa.createSession).not.toHaveBeenCalled();
    });

    it('rejects a semel that is not a positive finite number', async () => {
      for (const semel of [0, -1, 'abc', '', null, undefined, NaN, Infinity, {}]) {
        expect(await thrown(() => session({ semel }))).toEqual({
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }
      expect(mockMfa.createSession).not.toHaveBeenCalled();
    });

    it('accepts a numeric string semel and passes it on as a number', async () => {
      await session({ semel: '482273' });
      expect(mockMfa.createSession).toHaveBeenCalledWith(
        CHALLENGE,
        expect.objectContaining({ semel: 482273 }),
        expect.any(String),
      );
    });

    it('trims the username and refuses one that is only whitespace', async () => {
      await session({ username: '  303977367  ' });
      expect(mockMfa.createSession).toHaveBeenCalledWith(
        CHALLENGE,
        expect.objectContaining({ username: USERNAME }),
        expect.any(String),
      );

      expect(await thrown(() => session({ username: '   ' }))).toEqual({
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    });

    it('refuses a code that is only whitespace', async () => {
      expect(await thrown(() => session({ code: '   ' }))).toEqual({
        status: 400,
        code: 'VALIDATION_ERROR',
      });
      expect(mockMfa.createSession).not.toHaveBeenCalled();
    });

    it('sends no password upstream through the controller’s own payload', async () => {
      // The password is needed for OUR stored credential, not for Mashov's
      // verify call -- `MfaService` is what strips it. The controller must at
      // least not invent extra fields.
      await session();
      expect(Object.keys(mockMfa.createSession.mock.calls[0][1]).sort()).toEqual([
        'code',
        'password',
        'semel',
        'username',
      ]);
    });

    it('never answers 401 on any validation path', async () => {
      // `apiFetch` hard-redirects on any 401 whose code is not
      // INVALID_CREDENTIALS, which would throw the parent off the code screen
      // mid-sign-in.
      const bad: Array<Record<string, unknown>> = [
        { semel: 'x' },
        { username: '' },
        { code: '' },
        { password: '' },
      ];
      for (const body of bad) {
        expect((await thrown(() => session(body))).status).not.toBe(401);
      }
      expect(
        (await thrown(() => controller.sendCode('', { method: 'email' }, req))).status,
      ).not.toBe(401);
    });

    it('sets no cookie when validation fails', async () => {
      const response = res();
      await thrown(() => session({ code: '' }, response));
      expect(response.cookies).toHaveLength(0);
    });
  });
});
