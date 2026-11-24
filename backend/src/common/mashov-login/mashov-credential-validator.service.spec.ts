import { BadGatewayException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, CanceledError } from 'axios';
import { MashovCredentialValidatorService } from './mashov-credential-validator.service';
import { MASHOV_CSRF_TOKEN } from './mashov-login-body';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockHttp = {
  get: jest.fn(),
  post: jest.fn(),
  interceptors: { request: { use: jest.fn() } },
};

const input = { semel: 12345, year: 2027, username: 'testuser', password: 'pw' };

function okResponse(headers: Record<string, unknown> = {}) {
  return { data: { credential: { userId: 'u1' } }, headers };
}

describe('MashovCredentialValidatorService', () => {
  let service: MashovCredentialValidatorService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.create = jest.fn().mockReturnValue(mockHttp);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MashovCredentialValidatorService,
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      ],
    }).compile();

    service = module.get(MashovCredentialValidatorService);
  });

  describe('postLogin', () => {
    it('posts the shared login body with the shared CSRF token', async () => {
      mockHttp.post.mockResolvedValue(okResponse());

      await service.postLogin(input);

      const [path, body, config] = mockHttp.post.mock.calls[0];
      expect(path).toBe('/api/login');
      expect(body).toMatchObject({
        semel: 12345,
        year: 2027,
        username: 'testuser',
        password: 'pw',
        appName: 'info.mashov.students',
      });
      expect(config.headers['X-Csrf-Token']).toBe(MASHOV_CSRF_TOKEN);
    });

    it('forwards a captcha token into the login body', async () => {
      mockHttp.post.mockResolvedValue(okResponse());

      await service.postLogin({ ...input, captcha: 'tok-1' });

      expect(mockHttp.post.mock.calls[0][1]).toMatchObject({ captcha: 'tok-1' });
    });

    it('sends a stored uniquId as a Cookie header', async () => {
      mockHttp.post.mockResolvedValue(okResponse());

      await service.postLogin({ ...input, uniqueId: 'uid-7' });

      expect(mockHttp.post.mock.calls[0][2].headers.Cookie).toBe('uniquId=uid-7');
    });

    it('reads the uniquId set-cookie back out', async () => {
      mockHttp.post.mockResolvedValue(
        okResponse({ 'set-cookie': ['uniquId=abc123; Path=/; HttpOnly'] }),
      );

      const result = await service.postLogin(input);

      expect(result.newUniqueId).toBe('abc123');
    });

    // Needed by the MFA/sync bridge: `devicePass` is what lets a cron
    // re-login via POST /api/loginDevice without re-triggering the challenge.
    it('captures the devicePass response header', async () => {
      mockHttp.post.mockResolvedValue(okResponse({ devicepass: 'dp-xyz' }));

      const result = await service.postLogin(input);

      expect(result.devicePass).toBe('dp-xyz');
    });

    it('captures the devicePass header whatever its casing', async () => {
      mockHttp.post.mockResolvedValue(okResponse({ devicePass: 'dp-mixed' }));

      const result = await service.postLogin(input);

      expect(result.devicePass).toBe('dp-mixed');
    });

    it('captures the X-Csrf-Token response header', async () => {
      mockHttp.post.mockResolvedValue(okResponse({ 'x-csrf-token': 'csrf-9' }));

      const result = await service.postLogin(input);

      expect(result.csrfToken).toBe('csrf-9');
    });

    it('leaves the header fields undefined when Mashov sends neither', async () => {
      mockHttp.post.mockResolvedValue(okResponse());

      const result = await service.postLogin(input);

      expect(result.devicePass).toBeUndefined();
      expect(result.csrfToken).toBeUndefined();
    });
  });

  describe('validate', () => {
    it('returns the payload on success', async () => {
      mockHttp.post.mockResolvedValue(okResponse());

      await expect(service.validate(input)).resolves.toMatchObject({
        data: { credential: { userId: 'u1' } },
      });
    });

    it('reports an unreachable upstream as UPSTREAM_ERROR, not bad credentials', async () => {
      jest.spyOn(axios, 'isCancel').mockReturnValue(true);
      mockHttp.post.mockRejectedValue(new CanceledError('aborted'));

      await expect(service.validate(input)).rejects.toThrow(BadGatewayException);
    });

    it('reports a rejection as INVALID_CREDENTIALS', async () => {
      jest.spyOn(axios, 'isCancel').mockReturnValue(false);
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
      const err = new AxiosError('unauthorized');
      err.response = { status: 401 } as AxiosError['response'];
      mockHttp.post.mockRejectedValue(err);

      await expect(service.validate(input)).rejects.toThrow(UnauthorizedException);
    });
  });
});
