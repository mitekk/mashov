import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MashovRecoveryService } from './mashov-recovery.service';
import { MASHOV_CSRF_TOKEN } from './mashov-login-body';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockHttp = {
  get: jest.fn(),
  post: jest.fn(),
  interceptors: { request: { use: jest.fn() } },
};

function ok(data: unknown = {}, headers: Record<string, unknown> = {}) {
  return { data, headers };
}

/** `[path, body, config]` of the single post the call under test made. */
function lastPost() {
  const call = mockHttp.post.mock.calls[mockHttp.post.mock.calls.length - 1];
  return {
    path: call[0] as string,
    body: call[1] as Record<string, unknown>,
    config: call[2] as { headers: Record<string, string> },
  };
}

describe('MashovRecoveryService', () => {
  let service: MashovRecoveryService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.create = jest.fn().mockReturnValue(mockHttp);
    mockHttp.post.mockResolvedValue(ok());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MashovRecoveryService,
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      ],
    }).compile();

    service = module.get(MashovRecoveryService);
  });

  describe('requestRecovery', () => {
    it('posts the documented body to /api/user/recover', async () => {
      await service.requestRecovery({ semel: 482273, idNumber: '303977367', email: true });

      const { path, body } = lastPost();
      expect(path).toBe('/api/user/recover');
      expect(body).toEqual({ semel: 482273, idNumber: '303977367', email: true });
    });

    it('asks for the SMS channel with cellphone instead of email', async () => {
      await service.requestRecovery({
        semel: 482273,
        idNumber: '303977367',
        cellphone: true,
      });

      expect(lastPost().body).toEqual({
        semel: 482273,
        idNumber: '303977367',
        cellphone: true,
      });
    });

    it('sends the shared CSRF token like every other Mashov call', async () => {
      await service.requestRecovery({ semel: 1, idNumber: '1', email: true });
      expect(lastPost().config.headers['X-Csrf-Token']).toBe(MASHOV_CSRF_TOKEN);
    });

    it('reports the two-channel flag back to the caller', async () => {
      mockHttp.post.mockResolvedValue(ok({ isResettingAndVerifying: true }));

      const result = await service.requestRecovery({
        semel: 1,
        idNumber: '1',
        email: true,
      });

      expect(result.isResettingAndVerifying).toBe(true);
    });
  });

  describe('resetPassword', () => {
    it('puts the code in the path and the password in the body', async () => {
      await service.resetPassword('ABC123', 'secret1');

      const { path, body } = lastPost();
      expect(path).toBe('/api/user/reset/ABC123');
      expect(body).toEqual({ newPassword: 'secret1' });
    });

    it('strips whitespace out of the code before using it', async () => {
      // Parents paste codes with spaces, and Mashov's own client strips them.
      await service.resetPassword(' AB C 123 \n', 'secret1');
      expect(lastPost().path).toBe('/api/user/reset/ABC123');
    });

    it('percent-encodes the code rather than splicing it into the path raw', async () => {
      await service.resetPassword('a/b?c#d', 'secret1');
      expect(lastPost().path).toBe('/api/user/reset/a%2Fb%3Fc%23d');
    });
  });

  describe('resetPasswordVerify', () => {
    it('hits the one-code verify path when there is one code', async () => {
      await service.resetPasswordVerify('AAA111', undefined, 'secret1');
      expect(lastPost().path).toBe('/api/user/reset/verify/AAA111');
    });

    it('appends the second code as a second path segment', async () => {
      await service.resetPasswordVerify('AAA111', 'BBB222', 'secret1');
      expect(lastPost().path).toBe('/api/user/reset/verify/AAA111/BBB222');
    });

    it('strips whitespace out of both codes', async () => {
      await service.resetPasswordVerify('AAA 111', ' BBB 222 ', 'secret1');
      expect(lastPost().path).toBe('/api/user/reset/verify/AAA111/BBB222');
    });

    it('treats a blank second code as absent rather than as an empty segment', async () => {
      // `/verify/AAA111/` is a different upstream route from `/verify/AAA111`.
      await service.resetPasswordVerify('AAA111', '   ', 'secret1');
      expect(lastPost().path).toBe('/api/user/reset/verify/AAA111');
    });
  });

  describe('sendMfa', () => {
    it('posts the challenge id and the method', async () => {
      await service.sendMfa('ch-1', 'sms');

      const { path, body } = lastPost();
      expect(path).toBe('/api/login/mfa/send');
      expect(body).toEqual({ challengeId: 'ch-1', method: 'sms' });
    });
  });

  describe('verifyMfa', () => {
    const loginData = { semel: 482273, year: 2027, username: 'testuser' };

    it('posts the login data plus the challenge, code and remember flag', async () => {
      await service.verifyMfa({
        loginData,
        challengeId: 'ch-1',
        code: '123456',
        rememberBrowser: true,
      });

      const { path, body } = lastPost();
      expect(path).toBe('/api/login/mfa/verify');
      expect(body).toMatchObject({
        semel: 482273,
        year: 2027,
        username: 'testuser',
        challengeId: 'ch-1',
        code: '123456',
        rememberBrowser: true,
      });
    });

    it('strips the fields Mashov rejects on this route', async () => {
      await service.verifyMfa({
        loginData: {
          ...loginData,
          password: 'pw',
          captcha: 'tok',
        },
        challengeId: 'ch-1',
        code: '123456',
        rememberBrowser: false,
      });

      const { body } = lastPost();
      expect(body).not.toHaveProperty('password');
      expect(body).not.toHaveProperty('newPassword');
      expect(body).not.toHaveProperty('captcha');
      expect(body).not.toHaveProperty('mfaChallengeId');
    });

    it('strips whitespace out of the code', async () => {
      await service.verifyMfa({
        loginData,
        challengeId: 'ch-1',
        code: '123 456',
        rememberBrowser: true,
      });
      expect(lastPost().body.code).toBe('123456');
    });

    it('captures the devicePass so the trusted-device path can be stored', async () => {
      mockHttp.post.mockResolvedValue(
        ok({ credential: { userId: 'u1' } }, { devicepass: 'dp-1', 'x-csrf-token': 'c-1' }),
      );

      const result = await service.verifyMfa({
        loginData,
        challengeId: 'ch-1',
        code: '123456',
        rememberBrowser: true,
      });

      expect(result.devicePass).toBe('dp-1');
      expect(result.csrfToken).toBe('c-1');
      expect(result.data).toMatchObject({ credential: { userId: 'u1' } });
    });
  });

  describe('loginDevice', () => {
    it('posts an empty body with the devicePass header', async () => {
      // This is the whole MFA-and-sync bridge: a re-login that skips the
      // challenge, so 16 cron tasks do not re-trigger MFA every morning.
      await service.loginDevice('dp-1');

      const { path, body, config } = lastPost();
      expect(path).toBe('/api/loginDevice');
      expect(body).toEqual({});
      expect(config.headers.devicePass).toBe('dp-1');
    });

    it('returns a fresh devicePass when Mashov rotates it', async () => {
      mockHttp.post.mockResolvedValue(ok({}, { devicepass: 'dp-2' }));
      expect((await service.loginDevice('dp-1')).devicePass).toBe('dp-2');
    });

    it('sends the stored uniquId cookie when there is one', async () => {
      await service.loginDevice('dp-1', 'uid-5');
      expect(lastPost().config.headers.Cookie).toBe('uniquId=uid-5');
    });
  });

  describe('secrecy', () => {
    /**
     * Every file in this surface that logs at all.
     *
     * This list used to be one entry, and that was the gap: the OTP and MFA
     * classifiers shipped a "that code is not valid" answer for a stage with no
     * code, and when they were given the log line that makes such a failure
     * diagnosable, nothing was checking what those lines carried. A gate that
     * guards one of four files is a gate that will be routed around.
     */
    const LOGGING_FILES = [
      'mashov-recovery.service.ts',
      'mashov-reason.ts',
      '../../auth/otp.service.ts',
      '../../auth/mfa.service.ts',
    ];

    for (const file of LOGGING_FILES) {
      it(`logs nothing that interpolates a password or a code in ${file}`, () => {
        // The one guarantee that matters most here. This surface holds
        // single-use codes and plaintext passwords it must never persist
        // anywhere -- not Redis, not a log line, not a breadcrumb.
        const source = require('node:fs').readFileSync(
          require('node:path').join(__dirname, file),
          'utf8',
        ) as string;

        const logLines = source
          .split('\n')
          .filter((line) => /this\.logger\.|console\./.test(line));

        for (const line of logLines) {
          expect(line).not.toMatch(/newPassword|\bcode\b|captcha|devicePass|idNumber/);
        }
      });
    }

    it('never logs the request URL, which can itself be a single-use code', () => {
      // `resetPassword` puts the recovery code IN the path. Any log line built
      // from `err.config.url` would write live recovery codes to the logs, so
      // `describeMashovFailure` takes a caller-supplied literal instead and no
      // file in this surface may reach for the real one.
      const fs = require('node:fs');
      const path = require('node:path');

      for (const file of LOGGING_FILES) {
        const source = fs.readFileSync(path.join(__dirname, file), 'utf8') as string;
        const offending = source
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('*'))
          .filter((line) => /config\??\.(url|data|headers)/.test(line));
        expect(offending).toEqual([]);
      }
    });
  });

  describe('changePassword', () => {
    const loginData = { semel: 482273, year: 2027, username: 'u', password: 'old' };

    it('posts the login data plus the new password', async () => {
      await service.changePassword({ loginData, newPassword: 'secret1' });

      const { path, body } = lastPost();
      expect(path).toBe('/api/user/password');
      expect(body).toMatchObject({
        semel: 482273,
        username: 'u',
        // The CURRENT password stays: this route proves it before changing it.
        password: 'old',
        newPassword: 'secret1',
      });
    });

    it('echoes the challenge id back as mfaChallengeId', async () => {
      // The 403 that demanded the change carries it, and Mashov wants it back
      // under the request-side name.
      await service.changePassword({
        loginData,
        newPassword: 'secret1',
        challengeId: 'ch-5',
      });

      expect(lastPost().body).toMatchObject({ mfaChallengeId: 'ch-5' });
    });

    it('omits mfaChallengeId when there was no challenge', async () => {
      await service.changePassword({ loginData, newPassword: 'secret1' });
      expect(lastPost().body).not.toHaveProperty('mfaChallengeId');
    });
  });

  describe('changeUsername', () => {
    const loginData = { semel: 482273, year: 2027, username: 'u', password: 'old' };

    it('posts the login data with the NEW username in place', async () => {
      await service.changeUsername({ loginData, username: 'newname' });

      const { path, body } = lastPost();
      expect(path).toBe('/api/user/username');
      expect(body.username).toBe('newname');
      expect(body).not.toHaveProperty('newPassword');
    });
  });

  describe('requestOtp', () => {
    it('posts the school, username and channel', async () => {
      await service.requestOtp({ semel: 482273, username: 'u', method: 'sms' });

      const { path, body } = lastPost();
      expect(path).toBe('/api/user/otp/request');
      expect(body).toEqual({ semel: 482273, username: 'u', method: 'sms' });
    });
  });

  describe('verifyOtp', () => {
    const loginData = { semel: 482273, year: 2027, username: 'u' };

    it('posts the login data plus the code', async () => {
      await service.verifyOtp({ loginData, code: '123456' });

      const { path, body } = lastPost();
      expect(path).toBe('/api/user/otp');
      expect(body).toMatchObject({ semel: 482273, username: 'u', code: '123456' });
    });

    it('strips the code of whitespace', async () => {
      await service.verifyOtp({ loginData, code: '123 456' });
      expect(lastPost().body.code).toBe('123456');
    });

    it('carries no password, by construction', async () => {
      await service.verifyOtp({
        loginData: { ...loginData, password: 'leaked' },
        code: '123456',
      });
      expect(lastPost().body).not.toHaveProperty('password');
    });

    it('captures the session headers so a session can be minted', async () => {
      mockHttp.post.mockResolvedValue(
        ok({ credential: { userId: 'u1' } }, { devicepass: 'dp-9' }),
      );

      const result = await service.verifyOtp({ loginData, code: '123456' });

      expect(result.devicePass).toBe('dp-9');
      expect(result.data).toMatchObject({ credential: { userId: 'u1' } });
    });
  });
});
