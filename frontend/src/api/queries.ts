import { useQuery } from '@tanstack/react-query';

import type { ApiClient } from './client';
import { useApi } from './context';
import type { Belt, StudentFilters, StudentView } from './types';

export const queryKeys = {
  belts: ['belts'] as const,
  students: (filters: StudentFilters = {}) => ['students', filters] as const,
};

export function listBelts(api: ApiClient): Promise<Belt[]> {
  return api.get<Belt[]>('/belts');
}

export function listStudents(api: ApiClient, filters: StudentFilters = {}): Promise<StudentView[]> {
  return api.get<StudentView[]>('/students', {
    active: filters.active,
    belt_id: filters.belt_id,
    reference_date: filters.reference_date,
  });
}

/** `GET /belts`, in graduation order. */
export function useBelts() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.belts, queryFn: () => listBelts(api) });
}

/** `GET /students` with the API-computed age and eligibility. */
export function useStudents(filters: StudentFilters = {}) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.students(filters),
    queryFn: () => listStudents(api, filters),
  });
}
