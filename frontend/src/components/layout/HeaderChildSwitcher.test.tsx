import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathname = vi.fn(() => '/children/guid-1');
const push = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => pathname(),
  useRouter: () => ({ push }),
}));

const useChildren = vi.fn(() => ({ data: undefined }) as { data: unknown });
vi.mock('@/hooks/useChildren', () => ({ useChildren: () => useChildren() }));

const setSelectedChildGuid = vi.fn();
vi.mock('@/hooks/useSelectedChild', () => ({
  useSelectedChild: () => ({ setSelectedChildGuid }),
}));

const { HeaderChildSwitcher, childWorkspaceGuid } = await import('./HeaderChildSwitcher');

function children(count: number) {
  return {
    data: {
      data: Array.from({ length: count }, (_, i) => ({
        studentGuid: `guid-${i + 1}`,
        fullName: `ילד ${i + 1}`,
        isActive: true,
        schoolId: null,
        schoolShortLabel: null,
      })),
    },
  };
}

beforeEach(() => {
  pathname.mockReset();
  pathname.mockReturnValue('/children/guid-1');
  useChildren.mockReset();
  useChildren.mockReturnValue(children(2));
  push.mockReset();
  setSelectedChildGuid.mockReset();
});

describe('childWorkspaceGuid', () => {
  it('reads the guid of a workspace route', () => {
    expect(childWorkspaceGuid('/children/guid-1')).toBe('guid-1');
  });

  it('ignores a deeper detail route', () => {
    // A homework or behaviour item belongs to one child; switching children
    // from there has no destination, so those routes keep the plain title.
    expect(childWorkspaceGuid('/children/guid-1/homework/hw-1')).toBeNull();
  });

  it('ignores the list itself and everything outside it', () => {
    expect(childWorkspaceGuid('/children')).toBeNull();
    expect(childWorkspaceGuid('/inbox/conv-1')).toBeNull();
  });
});

describe('HeaderChildSwitcher', () => {
  it('offers the household on a workspace route', () => {
    render(<HeaderChildSwitcher />);

    const trigger = screen.getByTestId('child-header-selector');
    expect(trigger.getAttribute('aria-label')).toBe('בחר ילד');
    expect(trigger.textContent).toContain('ילד 1');
  });

  it('keeps the id the existing selectors resolve through', () => {
    render(<HeaderChildSwitcher />);

    expect(screen.getByTestId('child-header-selector').id).toBe('child-header-selector');
  });

  it('renders nothing on a detail route', () => {
    pathname.mockReturnValue('/children/guid-1/behavior/beh-1');
    render(<HeaderChildSwitcher />);

    expect(screen.queryByTestId('child-header-selector')).toBeNull();
  });

  /**
   * The app header renders on every page. Called unconditionally here,
   * `useChildren()` fired `GET /api/v1/children` on /home, /inbox and /more
   * too -- and where that request 401s, `apiFetch` hard-navigates to
   * `/auth/sign-in`. 36 home and inbox e2e specs logged themselves out.
   */
  it('does not even load the household list off the workspace route', () => {
    pathname.mockReturnValue('/home');
    render(<HeaderChildSwitcher />);

    expect(useChildren).not.toHaveBeenCalled();
  });

  it('loads the household list on the workspace route', () => {
    render(<HeaderChildSwitcher />);

    expect(useChildren).toHaveBeenCalled();
  });

  it('renders nothing before the child list has arrived', () => {
    // A `value` with no matching item renders an empty trigger, which reads as
    // a broken control next to the title.
    useChildren.mockReturnValue({ data: undefined });
    render(<HeaderChildSwitcher />);

    expect(screen.queryByTestId('child-header-selector')).toBeNull();
  });

  it('renders nothing when the open child is not in the household list', () => {
    pathname.mockReturnValue('/children/guid-unknown');
    render(<HeaderChildSwitcher />);

    expect(screen.queryByTestId('child-header-selector')).toBeNull();
  });
});
