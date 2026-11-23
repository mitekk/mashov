import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type { SchoolLink } from '@/types/api';
import { SchoolLinksCard } from './SchoolLinksCard';

const updateSchoolLink = vi.fn();
vi.mock('@/api/schoolLinks', () => ({
  updateSchoolLink: (...args: unknown[]) => updateSchoolLink(...args),
}));

function link(overrides: Partial<SchoolLink> = {}): SchoolLink {
  return {
    id: 'conn-a',
    semel: 540175,
    schoolName: 'אורט רמון',
    shortLabel: 'רמון',
    schoolYear: 2027,
    username: '303977367',
    childrenCount: 2,
    isPrimary: true,
    lastLoginAt: '2026-11-18T08:00:00Z',
    lastSyncAt: '2026-11-18T08:05:00Z',
    active: true,
    credentialStale: false,
    ...overrides,
  };
}

function renderCard(links: SchoolLink[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SchoolLinksCard links={links} onUnlink={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  updateSchoolLink.mockResolvedValue(link());
});

describe('SchoolLinksCard credential-stale banner', () => {
  it('shows nothing extra for a healthy school', async () => {
    renderCard([link()]);
    expect(screen.queryByTestId('school-credential-stale-banner-540175')).toBeNull();
  });

  it('names the school whose stored password stopped working', async () => {
    // A reset through our recovery flow leaves a valid session and a dead
    // background sync. Without this the parent just sees data stop updating.
    renderCard([link({ credentialStale: true })]);

    const banner = screen.getByTestId('school-credential-stale-banner-540175');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/[֐-׿]/);
  });

  it('flags only the school that needs attention in a two-school household', async () => {
    // The whole reason the flag is per school: reset school B, sign in with
    // A's password, and the app works while B is dead.
    renderCard([
      link({ credentialStale: false }),
      link({ id: 'conn-b', semel: 999999, credentialStale: true }),
    ]);

    expect(screen.queryByTestId('school-credential-stale-banner-540175')).toBeNull();
    expect(screen.getByTestId('school-credential-stale-banner-999999')).toBeInTheDocument();
  });

  it('submits the re-entered password to that school link', async () => {
    renderCard([link({ credentialStale: true })]);

    fireEvent.click(screen.getByTestId('school-credential-reenter-btn-540175'));
    fireEvent.change(screen.getByTestId('school-credential-password-540175'), {
      target: { value: 'newsecret1' },
    });
    fireEvent.click(screen.getByTestId('school-credential-submit-540175'));

    await waitFor(() => {
      expect(updateSchoolLink).toHaveBeenCalledWith('conn-a', {
        password: 'newsecret1',
      });
    });
  });

  it('refuses to submit an empty password rather than sending a blank one', async () => {
    renderCard([link({ credentialStale: true })]);

    fireEvent.click(screen.getByTestId('school-credential-reenter-btn-540175'));
    fireEvent.click(screen.getByTestId('school-credential-submit-540175'));

    expect(updateSchoolLink).not.toHaveBeenCalled();
    expect(screen.getByTestId('school-credential-error-540175')).toBeInTheDocument();
  });

  it('reports a rejected password instead of silently doing nothing', async () => {
    updateSchoolLink.mockRejectedValue(new Error('nope'));
    renderCard([link({ credentialStale: true })]);

    fireEvent.click(screen.getByTestId('school-credential-reenter-btn-540175'));
    fireEvent.change(screen.getByTestId('school-credential-password-540175'), {
      target: { value: 'wrongpw1' },
    });
    fireEvent.click(screen.getByTestId('school-credential-submit-540175'));

    await waitFor(() => {
      expect(screen.getByTestId('school-credential-error-540175')).toBeInTheDocument();
    });
  });

  it('uses a password input, so the value is never rendered in the clear', async () => {
    renderCard([link({ credentialStale: true })]);
    fireEvent.click(screen.getByTestId('school-credential-reenter-btn-540175'));

    expect(screen.getByTestId('school-credential-password-540175')).toHaveAttribute(
      'type',
      'password',
    );
  });
});

describe('SchoolLinksCard review fixes', () => {
  it('reports an outage as an outage, not as a rejected password', async () => {
    // `PUT /school-links/:id` answers 502 UPSTREAM_ERROR for an unreachable
    // Mashov precisely so this lie is not told. Telling the parent their
    // password was refused sends them to change a password that is fine.
    updateSchoolLink.mockRejectedValue(
      new ApiError(502, 'down', {
        error: { code: 'UPSTREAM_ERROR', message: 'down', details: [] },
      }),
    );
    renderCard([link({ credentialStale: true })]);

    fireEvent.click(screen.getByTestId('school-credential-reenter-btn-540175'));
    fireEvent.change(screen.getByTestId('school-credential-password-540175'), {
      target: { value: 'secret1' },
    });
    fireEvent.click(screen.getByTestId('school-credential-submit-540175'));

    await waitFor(() => {
      expect(screen.getByTestId('school-credential-error-540175').textContent).toContain(
        'משוב אינו זמין כרגע',
      );
    });
  });

  it('still names a rejected password as a rejected password', async () => {
    updateSchoolLink.mockRejectedValue(
      new ApiError(401, 'nope', {
        error: { code: 'INVALID_CREDENTIALS', message: 'nope', details: [] },
      }),
    );
    renderCard([link({ credentialStale: true })]);

    fireEvent.click(screen.getByTestId('school-credential-reenter-btn-540175'));
    fireEvent.change(screen.getByTestId('school-credential-password-540175'), {
      target: { value: 'wrongpw1' },
    });
    fireEvent.click(screen.getByTestId('school-credential-submit-540175'));

    await waitFor(() => {
      expect(screen.getByTestId('school-credential-error-540175').textContent).toContain(
        'פרטי הכניסה שגויים',
      );
    });
  });
});
