import { useQuery } from '@tanstack/react-query';
import { fetchSchoolLinks } from '@/api/schoolLinks';

/**
 * The connected schools, with their child counts and sync state.
 *
 * Only `/more` needs this. Every other surface reads `me.schools`, which the
 * app shell already has cached -- fetching the management fields on every page
 * would be two requests for one badge.
 */
export function useSchoolLinks() {
  return useQuery({
    queryKey: ['school-links'],
    queryFn: fetchSchoolLinks,
    staleTime: 60_000,
  });
}
