import { apiFetch } from './client';
import type { DashboardResponse } from '@/types/api';

export async function fetchDashboard(): Promise<DashboardResponse> {
  const response = await apiFetch<DashboardResponse>('/dashboard');
  return {
    ...response,
    children: Array.isArray(response.children)
      ? response.children.map((child) => ({
          ...child,
          positiveBehaviorCount: Number(child.positiveBehaviorCount ?? 0),
          neutralBehaviorCount: Number(child.neutralBehaviorCount ?? 0),
        }))
      : [],
  };
}
