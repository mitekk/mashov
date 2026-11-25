import { NAV_ITEMS, isNavItemActive } from './navItems';

/**
 * The page title the sticky header carries, per top-level section.
 *
 * A separate map rather than `NavItem.label`: the nav button says בית because
 * it sits next to three other one-word buttons, while the page it opens is
 * מרכז הורים. Keyed by `href`, so a detail route inherits its section's title
 * through `isNavItemActive`.
 */
const HEADER_TITLES: Record<string, string> = {
  '/home': 'מרכז הורים',
  '/children': 'ילדים',
  '/inbox': 'דואר',
  '/more': 'עוד',
};

/** The header title for `pathname`, or `null` outside the four sections. */
export function resolveHeaderTitle(pathname: string): string | null {
  const item = NAV_ITEMS.find((i) => isNavItemActive(i, pathname));
  return item ? HEADER_TITLES[item.href] ?? null : null;
}
