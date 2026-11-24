'use client';

import React from 'react';
import { Home, Mail, MoreHorizontal, Users } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';

export interface NavItem {
  href: string;
  /** Prefix that marks this item active; defaults to `href`. */
  activeRoot?: string;
  label: string;
  testId: string;
  icon: React.ReactNode;
  /**
   * Which live counter decorates this item. Declared as data rather than
   * resolved here so `NAV_ITEMS` stays pure and renderable without a
   * QueryClient in the tree.
   */
  badgeSource?: 'unreadConversations';
}

/** The four top-level destinations, in display order. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: '/home',
    label: 'בית',
    testId: 'nav-home',
    icon: <Home className="h-5 w-5" />,
  },
  {
    href: '/children',
    label: 'ילדים',
    testId: 'nav-children',
    icon: <Users className="h-5 w-5" />,
  },
  {
    href: '/inbox',
    label: 'דואר',
    testId: 'nav-inbox',
    icon: <Mail className="h-5 w-5" />,
    badgeSource: 'unreadConversations',
  },
  {
    href: '/more',
    label: 'עוד',
    testId: 'nav-more',
    icon: <MoreHorizontal className="h-5 w-5" />,
  },
];

export interface ResolvedNavItem extends NavItem {
  /** Present only when the counter this item declares is non-zero. */
  badge?: number;
}

/** `NAV_ITEMS` with the live unread counter layered on top. */
export function useNavItems(): ResolvedNavItem[] {
  const { data } = useDashboard();
  const unreadCount = data?.summary.newConversations ?? 0;

  return NAV_ITEMS.map((item) => {
    if (item.badgeSource === 'unreadConversations' && unreadCount > 0) {
      return { ...item, badge: unreadCount };
    }
    return { ...item };
  });
}

/** Whether `pathname` is inside the section `item` points at. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  const activeRoot = item.activeRoot ?? item.href;
  return pathname === activeRoot || pathname.startsWith(activeRoot + '/');
}
