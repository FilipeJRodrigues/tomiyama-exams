import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ApiClient } from './client';
import { useApi } from './context';
import type { Belt, StudentFilters, StudentInput, StudentView } from './types';

export const queryKeys = {
  belts: ['belts'] as const,
  /** Prefix of every students list (any filter), for invalidation. */
  allStudents: ['students'] as const,
  students: (filters: StudentFilters = {}) => ['students', filters] as const,
  student: (id: string) => ['student', id] as const,
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

function studentPath(id: string): string {
  return `/students/${encodeURIComponent(id)}`;
}

export function getStudent(api: ApiClient, id: string): Promise<StudentView> {
  return api.get<StudentView>(studentPath(id));
}

export function createStudent(api: ApiClient, input: StudentInput): Promise<StudentView> {
  return api.post<StudentView>('/students', input);
}

export function updateStudent(
  api: ApiClient,
  id: string,
  input: StudentInput,
): Promise<StudentView> {
  return api.put<StudentView>(studentPath(id), input);
}

export function deleteStudent(api: ApiClient, id: string): Promise<void> {
  return api.delete(studentPath(id));
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

/** `GET /students/{id}`; 404 when the student is missing or belongs to someone else. */
export function useStudent(id: string) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.student(id), queryFn: () => getStudent(api, id) });
}

/** `POST /students`; the owner is the signed-in user (set by the API). */
export function useCreateStudent() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StudentInput) => createStudent(api, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.allStudents });
    },
  });
}

/** `PUT /students/{id}` with every field of the form. */
export function useUpdateStudent(id: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StudentInput) => updateStudent(api, id, input),
    onSuccess: (student) => {
      queryClient.setQueryData(queryKeys.student(id), student);
      void queryClient.invalidateQueries({ queryKey: queryKeys.allStudents });
    },
  });
}

/**
 * `DELETE /students/{id}`; 409 when the student has exams (RN018).
 *
 * The detail stays in the cache while its page is on screen (removing it there makes the
 * page ask the API again); call `forgetStudent` once the page has left.
 */
export function useDeleteStudent(id: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteStudent(api, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.allStudents });
    },
  });
}

/** Drop a deleted student's detail from the cache. */
export function useForgetStudent() {
  const queryClient = useQueryClient();
  return (id: string) => {
    queryClient.removeQueries({ queryKey: queryKeys.student(id) });
  };
}
