import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppSessionGuard } from './app-session.guard';
import { AppSessionService } from './app-session.service';

const mockAppSessionService = {
  validateSession: jest.fn(),
};

const mockReflector = {
  getAllAndOverride: jest.fn(),
};

function makeContext(cookieHeader?: string): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { cookie: cookieHeader ?? '' },
        user: undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('AppSessionGuard', () => {
  let guard: AppSessionGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new AppSessionGuard(
      mockAppSessionService as unknown as AppSessionService,
      mockReflector as unknown as Reflector,
    );
  });

  it('skips guard for public routes', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(true);
    const result = await guard.canActivate(makeContext());
    expect(result).toBe(true);
    expect(mockAppSessionService.validateSession).not.toHaveBeenCalled();
  });

  it('throws 401 when no cookie header', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(false);
    await expect(guard.canActivate(makeContext())).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 when mashov_session cookie absent', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(false);
    await expect(guard.canActivate(makeContext('other_cookie=abc'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 when session not found', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(false);
    mockAppSessionService.validateSession.mockResolvedValue(null);
    await expect(
      guard.canActivate(makeContext('mashov_session=badtoken')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('sets req.user and returns true for valid session', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(false);
    mockAppSessionService.validateSession.mockResolvedValue('user-42');

    const req: { headers: { cookie: string }; user?: { userId: string } } = {
      headers: { cookie: 'mashov_session=validtoken' },
      user: undefined,
    };
    const ctx = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req.user).toEqual({ userId: 'user-42' });
  });

  it('extracts token from cookie with multiple cookies', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(false);
    mockAppSessionService.validateSession.mockResolvedValue('user-1');

    const ctx = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { cookie: 'theme=dark; mashov_session=mytoken; lang=he' },
          user: undefined,
        }),
      }),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockAppSessionService.validateSession).toHaveBeenCalledWith('mytoken');
  });
});
