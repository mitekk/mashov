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
    /**
     * Captured from Mashov's own client on 2026-11-24, both channels. These
     * are the observed bytes, not a reading of the bundle.
     */
    it('posts the captured body to /api/user/recover', async () => {
      await service.requestRecovery({
        semel: 482273,
        idNumber: '303977367',
        email: 'parent@example.com',
      });

      const { path, body } = lastPost();
      expect(path).toBe('/api/user/recover');
      expect(body).toEqual({
        semel: 482273,
        idNumber: '303977367',
        email: 'parent@example.com',
      });
    });

    it('never sends a boolean, which is what broke this flow', async () => {
      // `email: true` will not bind to a .NET string property: Mashov answered
      // 400 and sent nothing, while our 202 told the parent to check an inbox.
      await service.requestRecovery({
        semel: 482273,
        idNumber: '303977367',
        email: 'parent@example.com',
      });
      expect(typeof (lastPost().body as { email: unknown }).email).toBe('string');
    });

    it('asks for the SMS channel with cellphone instead of email', async () => {
      // The field NAME is the channel -- there is no separate flag, and the
      // two fields are never both present.
      await service.requestRecovery({
        semel: 482273,
        idNumber: '303977367',
        cellphone: '0501234567',
      });

      expect(lastPost().body).toEqual({
        semel: 482273,
        idNumber: '303977367',
        cellphone: '0501234567',
      });
    });

    it('sends the shared CSRF token like every other Mashov call', async () => {
      await service.requestRecovery({ semel: 1, idNumber: '1', email: 'p@example.com' });
      expect(lastPost().config.headers['X-Csrf-Token']).toBe(MASHOV_CSRF_TOKEN);
    });

    /**
     * The nonce is the whole reason step 2 was failing.
     *
     * Mashov mints `NonceRef` on THIS response and requires it back on the
     * reset. It is read off `Set-Cookie` here because that is the only place
     * it ever exists -- discard it and no later call can reconstruct it.
     */
    it('reports the NonceRef cookie Mashov minted for this recovery', async () => {
      mockHttp.post.mockResolvedValue(
        ok(
          {},
          {
            'set-cookie': [
              'NonceRef=194f915d-c39f-35bd-478b-6ef894b9e771; expires=Wed, 25 Nov 2026 07:14:09 GMT; domain=web.mashov.info; path=/; secure; samesite=none; httponly',
            ],
          },
        ),
      );

      const result = await service.requestRecovery({
        semel: 1,
        idNumber: '1',
        email: 'p@example.com',
      });

      expect(result.nonceRef).toBe('194f915d-c39f-35bd-478b-6ef894b9e771');
    });

    it('reports no nonce when Mashov set no cookie, rather than inventing one', async () => {
      const result = await service.requestRecovery({
        semel: 1,
        idNumber: '1',
        email: 'p@example.com',
      });

      expect(result.nonceRef).toBeUndefined();
    });

    it('reports the two-channel flag back to the caller', async () => {
      mockHttp.post.mockResolvedValue(ok({ isResettingAndVerifying: true }));

      const result = await service.requestRecovery({
        semel: 1,
        idNumber: '1',
        email: 'p@example.com',
      });

      expect(result.body.isResettingAndVerifying).toBe(true);
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

    /**
     * Captured 2026-11-24 from the browser, against
     * `https://web.mashov.info/students/reset`. Every method on this class used
     * to send `/students/login`, which is the page the parent is NOT on for a
     * reset. See `apis/post-api-user-reset-token.md`.
     */
    it('sends the reset page as the Referer, not the login page', async () => {
      await service.resetPassword('ABC123', 'secret1');
      expect(lastPost().config.headers.Referer).toBe(
        'https://web.mashov.info/students/reset',
      );
    });

    /**
     * The nonce Mashov minted at step 1 -- NOT a session.
     *
     * An earlier capture recorded no cookie here, so this class sent none, and
     * Mashov answered `400 application/problem+json` with no `Reason` for a
     * code that was genuinely valid. We rendered that as
     * INVALID_RECOVERY_CODE and burned the attempt budget on it.
     *
     * Captured 2026-11-25 in a clean incognito session: `POST
     * /api/user/recover` answers `Set-Cookie: NonceRef=...` (10 minutes), and
     * the reset sends exactly that value back and nothing else. Proven by
     * replay with our own three headers plus the nonce: empty 200, password
     * changed. The cookie is minted inside the flow, so a server can hold it.
     *
     * Still no `uniquId` anywhere on this route, so the gap documented on
     * `headers()` genuinely does not apply.
     */
    it('sends back the NonceRef that step 1 minted', async () => {
      await service.resetPassword('ABC123', 'secret1', 'nonce-1');
      expect(lastPost().config.headers.Cookie).toBe('NonceRef=nonce-1');
    });

    it('sends no Cookie when there is no nonce to send', async () => {
      // Not `NonceRef=undefined`, which asserts a nonce we do not hold.
      await service.resetPassword('ABC123', 'secret1');
      expect(lastPost().config.headers.Cookie).toBeUndefined();
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

    it('sends the reset page as the Referer, like its single-channel sibling', async () => {
      // Not itself captured -- `apis/post-api-user-reset-verify.md` is read off
      // the bundle -- but it is step 2 of the same flow, reached from the same
      // `/students/reset` page. A parent on the two-code form is on that page.
      await service.resetPasswordVerify('AAA111', 'BBB222', 'secret1');
      expect(lastPost().config.headers.Referer).toBe(
        'https://web.mashov.info/students/reset',
      );
    });

    it('sends back the NonceRef too, like its single-channel sibling', async () => {
      await service.resetPasswordVerify('AAA111', 'BBB222', 'secret1', 'nonce-2');
      expect(lastPost().config.headers.Cookie).toBe('NonceRef=nonce-2');
    });

    it('sends no Cookie when there is no nonce to send', async () => {
      await service.resetPasswordVerify('AAA111', 'BBB222', 'secret1');
      expect(lastPost().config.headers.Cookie).toBeUndefined();
    });
  });

  /**
   * The `Referer` is per-route, not per-class.
   *
   * It used to be `/students/login` for every method here. That is what the
   * login and session routes are observed to send, and what they keep sending;
   * the two reset routes are reached from `/students/reset` instead.
   */
  describe('the Referer each route sends', () => {
    const LOGIN_REFERER = 'https://web.mashov.info/students/login';

    it('keeps the login page for the recovery request itself', async () => {
      // Step 1 is submitted from the login page's forgot-password form.
      await service.requestRecovery({ semel: 1, idNumber: '1', email: 'p@example.com' });
      expect(lastPost().config.headers.Referer).toBe(LOGIN_REFERER);
    });

    it.each([
      ['sendMfa', () => service.sendMfa('ch-1', 'sms')],
      [
        'verifyMfa',
        () =>
          service.verifyMfa({
            loginData: {},
            challengeId: 'ch-1',
            code: '123456',
            rememberBrowser: true,
          }),
      ],
      ['loginDevice', () => service.loginDevice('dp-1')],
      [
        'changePassword',
        () => service.changePassword({ loginData: {}, newPassword: 'secret1' }),
      ],
      [
        'changeUsername',
        () => service.changeUsername({ loginData: {}, username: 'parent' }),
      ],
    ])('keeps the login page for %s', async (_name, call) => {
      await call();
      expect(lastPost().config.headers.Referer).toBe(LOGIN_REFERER);
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

  /**
   * The stored `uniquId` device cookie.
   *
   * A real browser sends it on every same-origin request, so Mashov's own
   * client sends it on all of these routes. We sent it on `POST /api/login`
   * only, while the credential-change flows read `mashovUniqueId` from the
   * database, wrote down why it mattered, and dropped it on the floor.
   */
  describe('the device cookie', () => {

    it('sends it on a password change', async () => {
      await service.changePassword({
        loginData: { semel: 1 },
        newPassword: 'secret1',
        uniqueId: 'uid-7',
      });
      expect(lastPost().config.headers.Cookie).toBe('uniquId=uid-7');
    });

    it('sends it on a username change', async () => {
      await service.changeUsername({
        loginData: { semel: 1 },
        username: 'newname',
        uniqueId: 'uid-7',
      });
      expect(lastPost().config.headers.Cookie).toBe('uniquId=uid-7');
    });

    it('omits the header entirely when there is no stored cookie', async () => {
      // Not `Cookie: uniquId=null`, which would be a header asserting a
      // session that does not exist.
      await service.changePassword({
        loginData: { semel: 1 },
        newPassword: 'secret1',
        uniqueId: null,
      });
      expect(lastPost().config.headers.Cookie).toBeUndefined();
    });

    it('still sends none on MFA verify, deliberately', async () => {
      // Not an oversight: the `403 Reason: MfaRequired` that opens the
      // challenge makes axios throw, so its `Set-Cookie: uniquId` is
      // discarded and the stored value is an OLDER session's. If Mashov binds
      // the challenge to its cookie, a stale one is worse than none. See the
      // TODO in `mfa.service.ts` for what the capture has to settle.
      await service.verifyMfa({
        loginData: { semel: 1 },
        challengeId: 'ch-1',
        code: '123456',
        rememberBrowser: true,
      });
      expect(lastPost().config.headers.Cookie).toBeUndefined();
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
      '../../auth/mfa.service.ts',
      // Added when recovery gained logging. It holds an Israeli national ID
      // number in `input.idNumber`, so it is the file in this surface where the
      // gate matters most.
      '../../auth/credential-recovery.service.ts',
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


});
