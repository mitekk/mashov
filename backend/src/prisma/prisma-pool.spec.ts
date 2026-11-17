import {
  DEFAULT_CONNECTION_LIMIT,
  DEFAULT_POOL_TIMEOUT_SECONDS,
  withPoolSettings,
} from './prisma-pool';

const BASE = 'postgres://app:s3cret@db-host:5432/mashov';

describe('withPoolSettings', () => {
  it('appends the default pool settings when the URL carries none', () => {
    expect(withPoolSettings(BASE, {})).toBe(
      `${BASE}?connection_limit=${DEFAULT_CONNECTION_LIMIT}` +
        `&pool_timeout=${DEFAULT_POOL_TIMEOUT_SECONDS}`,
    );
  });

  it('joins with & when the URL already has a query string', () => {
    const result = withPoolSettings(`${BASE}?sslmode=disable`, {});
    expect(result).toBe(
      `${BASE}?sslmode=disable&connection_limit=${DEFAULT_CONNECTION_LIMIT}` +
        `&pool_timeout=${DEFAULT_POOL_TIMEOUT_SECONDS}`,
    );
  });

  it('reads overrides from the environment', () => {
    const result = withPoolSettings(BASE, {
      DATABASE_CONNECTION_LIMIT: '40',
      DATABASE_POOL_TIMEOUT: '30',
    });
    expect(result).toBe(`${BASE}?connection_limit=40&pool_timeout=30`);
  });

  // An operator who pinned a value in the URL itself has the final say; this
  // must not quietly double the parameter.
  it('leaves a parameter already present in the URL untouched', () => {
    const result = withPoolSettings(`${BASE}?connection_limit=5`, {});
    expect(result).toBe(
      `${BASE}?connection_limit=5&pool_timeout=${DEFAULT_POOL_TIMEOUT_SECONDS}`,
    );
  });

  it('ignores non-numeric and non-positive overrides', () => {
    for (const bad of ['', '   ', 'lots', '0', '-3']) {
      expect(withPoolSettings(BASE, { DATABASE_CONNECTION_LIMIT: bad })).toContain(
        `connection_limit=${DEFAULT_CONNECTION_LIMIT}`,
      );
    }
  });

  // The credentials are the one thing this must never rewrite: a URL
  // round-trip through the WHATWG parser re-encodes reserved characters in
  // the password, which silently breaks authentication.
  it('preserves credentials containing reserved characters byte for byte', () => {
    const gnarly = 'postgres://app:p%40ss/w:rd+%2F=@db-host:5432/mashov';
    expect(withPoolSettings(gnarly, {})).toBe(
      `${gnarly}?connection_limit=${DEFAULT_CONNECTION_LIMIT}` +
        `&pool_timeout=${DEFAULT_POOL_TIMEOUT_SECONDS}`,
    );
  });

  it('returns an unset URL unchanged rather than inventing one', () => {
    expect(withPoolSettings(undefined, {})).toBeUndefined();
    expect(withPoolSettings('', {})).toBe('');
  });
});
