import { apiFetch } from './client';
import type { FeedResponse } from '@/types/api';

export function fetchFeed(page = 1, limit = 20): Promise<FeedResponse> {
  return apiFetch<FeedResponse>(`/feed?page=${page}&limit=${limit}`);
}
