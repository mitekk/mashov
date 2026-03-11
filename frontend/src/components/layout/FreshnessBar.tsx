'use client';

import React from 'react';
import { useDashboard } from '@/hooks/useDashboard';
import { StaleIndicator } from '@/components/ui/StaleIndicator';

export function FreshnessBar() {
  const { data } = useDashboard();
  const status = data?.freshness.state ?? 'fresh';
  return <StaleIndicator status={status} />;
}
