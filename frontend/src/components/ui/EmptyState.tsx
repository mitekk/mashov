import React from 'react';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
}

export function EmptyState({ icon, title, subtitle }: EmptyStateProps) {
  return (
    <div className="card-base flex flex-col items-center justify-center px-4 py-12 text-center">
      {icon && (
        <div className="mb-4 text-muted-foreground/80 opacity-80">
          {icon}
        </div>
      )}
      <p className="mb-1 text-base font-medium text-foreground">{title}</p>
      {subtitle && (
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      )}
    </div>
  );
}
