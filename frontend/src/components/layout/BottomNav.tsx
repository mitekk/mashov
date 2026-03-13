'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Users, Mail, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDashboard } from '@/hooks/useDashboard';
import { useSelectedChild } from '@/hooks/useSelectedChild';
import { getChildrenNavHref } from '@/lib/child-routes';

interface NavItem {
  href: string;
  activeRoot?: string;
  label: string;
  testId: string;
  icon: React.ReactNode;
  badge?: number;
}

export function BottomNav() {
  const pathname = usePathname();
  const { data } = useDashboard();
  const { selectedChildGuid, setSelectedChildGuid } = useSelectedChild();
  const unreadCount = data?.summary.unreadConversations ?? 0;

  const selectedChildExists = Boolean(
    selectedChildGuid
    && data?.children.some((child) => child.studentGuid === selectedChildGuid),
  );

  useEffect(() => {
    if (!selectedChildGuid || !data) return;
    if (!selectedChildExists) {
      setSelectedChildGuid(null);
    }
  }, [selectedChildGuid, selectedChildExists, setSelectedChildGuid, data]);

  const childrenHref = getChildrenNavHref(
    selectedChildExists ? selectedChildGuid : null,
    'homework',
  );

  const navItems: NavItem[] = [
    {
      href: '/home',
      label: 'בית',
      testId: 'nav-home',
      icon: <Home className="w-5 h-5" />,
    },
    {
      href: childrenHref,
      activeRoot: '/children',
      label: 'ילדים',
      testId: 'nav-children',
      icon: <Users className="w-5 h-5" />,
    },
    {
      href: '/inbox',
      label: 'דואר',
      testId: 'nav-inbox',
      icon: <Mail className="w-5 h-5" />,
      badge: unreadCount > 0 ? unreadCount : undefined,
    },
    {
      href: '/more',
      label: 'עוד',
      testId: 'nav-more',
      icon: <MoreHorizontal className="w-5 h-5" />,
    },
  ];

  return (
    <nav
      data-testid="bottom-nav"
      className="fixed bottom-0 inset-x-0 bg-card border-t border-border z-50"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-stretch">
        {navItems.map((item) => {
          const activeRoot = item.activeRoot ?? item.href;
          const isActive =
            pathname === activeRoot || pathname.startsWith(activeRoot + '/');
          return (
            <Link
              key={item.testId}
              href={item.href}
              data-testid={item.testId}
              className={cn(
                'flex flex-col items-center justify-center flex-1 py-2 gap-1 tap-target transition-colors',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="relative">
                {item.icon}
                {item.badge !== undefined && (
                  <span className="absolute -top-1 -start-1 min-w-[16px] h-4 px-1 bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full flex items-center justify-center">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </span>
              <span className="text-[10px] font-medium leading-none">
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
