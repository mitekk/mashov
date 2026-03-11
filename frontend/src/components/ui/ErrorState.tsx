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
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <AlertCircle className="w-10 h-10 text-destructive mb-4 opacity-70" />
      <p className="text-base font-medium text-foreground mb-1">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          data-testid="error-retry-button"
          className="mt-4 px-4 py-2 text-sm font-medium text-primary border border-primary/30 rounded-lg hover:bg-primary/5 transition-colors tap-target"
        >
          נסה שנית
        </button>
      )}
    </div>
  );
}
