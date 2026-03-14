'use client';

import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  const nextLabel = isDark ? 'מצב בהיר' : 'מצב כהה';

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      aria-label={nextLabel}
      title={nextLabel}
      onClick={toggleTheme}
      className={cn(
        'tap-target inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/80 bg-card/85 text-muted-foreground shadow-sm transition-colors',
        'hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      {isDark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
    </button>
  );
}
