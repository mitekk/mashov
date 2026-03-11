import { apiFetch } from './client';
import type { DashboardResponse } from '@/types/api';

export function fetchDashboard(): Promise<DashboardResponse> {
  return apiFetch<DashboardResponse>('/dashboard');
}
