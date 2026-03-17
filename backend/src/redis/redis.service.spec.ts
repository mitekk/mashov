import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

// Build a standalone mock client — avoids jest.mock('ioredis') which can interfere
// with other specs when Jest workers share the module registry on some Node versions.
function buildMockClient() {
  return {
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(300),
    scan: jest.fn().mockResolvedValue(['0', []]),
  };
}

function buildService() {
  const mockConfig = { get: jest.fn().mockReturnValue('redis://localhost:6379') };
  const svc = new RedisService(mockConfig as unknown as ConfigService);
  const client = buildMockClient();
  // Bypass onModuleInit (which would connect to a real Redis) by injecting the mock
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).client = client;
  return { svc, client };
}

describe('RedisService', () => {
  it('get returns value from client', async () => {
    const { svc, client } = buildService();
    client.get.mockResolvedValue('hello');
    expect(await svc.get('k1')).toBe('hello');
    expect(client.get).toHaveBeenCalledWith('k1');
  });

  it('get returns null for missing key', async () => {
    const { svc, client } = buildService();
    client.get.mockResolvedValue(null);
    expect(await svc.get('missing')).toBeNull();
  });

  it('set without TTL calls client.set with two args', async () => {
    const { svc, client } = buildService();
    await svc.set('k', 'v');
    expect(client.set).toHaveBeenCalledWith('k', 'v');
  });

  it('set with TTL calls client.set with EX flag', async () => {
    const { svc, client } = buildService();
    await svc.set('k', 'v', 60);
    expect(client.set).toHaveBeenCalledWith('k', 'v', 'EX', 60);
  });

  it('del calls client.del', async () => {
    const { svc, client } = buildService();
    await svc.del('k');
    expect(client.del).toHaveBeenCalledWith('k');
  });

  it('incr returns the new counter value', async () => {
    const { svc, client } = buildService();
    client.incr.mockResolvedValue(3);
    expect(await svc.incr('counter')).toBe(3);
  });

  it('expire calls client.expire', async () => {
    const { svc, client } = buildService();
    await svc.expire('k', 120);
    expect(client.expire).toHaveBeenCalledWith('k', 120);
  });

  it('ttl returns remaining seconds', async () => {
    const { svc, client } = buildService();
    client.ttl.mockResolvedValue(250);
    expect(await svc.ttl('k')).toBe(250);
  });

  it('scanDel iterates pages and deletes matching keys', async () => {
    const { svc, client } = buildService();
    client.scan
      .mockResolvedValueOnce(['42', ['key:1', 'key:2']])
      .mockResolvedValueOnce(['0', []]);
    await svc.scanDel('key:*');
    expect(client.del).toHaveBeenCalledWith('key:1', 'key:2');
  });

  it('onModuleDestroy calls client.quit', async () => {
    const { svc, client } = buildService();
    await svc.onModuleDestroy();
    expect(client.quit).toHaveBeenCalled();
  });
});
