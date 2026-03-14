import React from 'react';
import { AlertCircle } from 'lucide-react';

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

export function ErrorState({
  message = 'אירעה שגיאה. אנא נסה שנית.',
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="card-base flex flex-col items-center justify-center px-4 py-12 text-center">
      <AlertCircle className="mb-4 h-10 w-10 text-destructive opacity-70" />
      <p className="mb-1 text-base font-medium text-foreground">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          data-testid="error-retry-button"
          className="tap-target mt-4 rounded-2xl border border-primary/30 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
        >
          נסה שנית
        </button>
      )}
    </div>
  );
}
