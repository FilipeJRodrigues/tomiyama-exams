import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, type ApiClient } from './client';
import { useApi } from './context';
import type {
  Belt,
  ConfirmAttendanceInput,
  ExamEvent,
  ExamSheet,
  ExamView,
  Examiner,
  StudentFilters,
  StudentInput,
  StudentView,
} from './types';

export const queryKeys = {
  belts: ['belts'] as const,
  /** Prefix of every students list (any filter), for invalidation. */
  allStudents: ['students'] as const,
  students: (filters: StudentFilters = {}) => ['students', filters] as const,
  student: (id: string) => ['student', id] as const,
  events: ['events'] as const,
  eventExams: (eventId: string) => ['events', eventId, 'exams'] as const,
  /** Under `eventExams`: reloading the event's exams also reloads the open exam sheet. */
  examSheet: (eventId: string, studentId: string) =>
    ['events', eventId, 'exams', studentId] as const,
  examiners: ['examiners'] as const,
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

export function listEvents(api: ApiClient): Promise<ExamEvent[]> {
  return api.get<ExamEvent[]>('/events');
}

function eventExamsPath(eventId: string): string {
  return `/events/${encodeURIComponent(eventId)}/exams`;
}

export function listEventExams(api: ApiClient, eventId: string): Promise<ExamView[]> {
  return api.get<ExamView[]>(eventExamsPath(eventId));
}

export function confirmAttendance(
  api: ApiClient,
  eventId: string,
  studentId: string,
): Promise<ExamView> {
  const body: ConfirmAttendanceInput = { student_id: studentId };
  return api.post<ExamView>(eventExamsPath(eventId), body);
}

export function getExamSheet(
  api: ApiClient,
  eventId: string,
  studentId: string,
): Promise<ExamSheet> {
  return api.get<ExamSheet>(`${eventExamsPath(eventId)}/${encodeURIComponent(studentId)}`);
}

export function listExaminers(api: ApiClient): Promise<Examiner[]> {
  return api.get<Examiner[]>('/examiners');
}

/** 409 message of a repeated confirmation (RN005), also when another examiner was first. */
export const MSG_ALREADY_CONFIRMED = 'Presença já confirmada neste evento';

/** The attendance was already confirmed: the screen only has to reload the exams. */
export function isAlreadyConfirmed(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 409 && error.message === MSG_ALREADY_CONFIRMED
  );
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

/** `GET /events`, from the most recent to the oldest (examiners only). */
export function useEvents() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.events, queryFn: () => listEvents(api) });
}

/** `GET /events/{id}/exams`: the event's exams, by student name. */
export function useEventExams(eventId: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.eventExams(eventId),
    queryFn: () => listEventExams(api, eventId),
  });
}

/**
 * `GET /events/{id}/exams/{student_id}` (§ 6.4): the exam, its items with the marks and the
 * RN007 summary. Reloaded whenever the window gets the focus back, so two examiners on the
 * same exam see each other's marks (set here explicitly, not only as the app default).
 */
export function useExamSheet(eventId: string, studentId: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.examSheet(eventId, studentId),
    queryFn: () => getExamSheet(api, eventId, studentId),
    refetchOnWindowFocus: 'always',
  });
}

/** `GET /examiners`: active examiners, to show who decided an exam. */
export function useExaminers() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.examiners, queryFn: () => listExaminers(api) });
}

/**
 * `POST /events/{id}/exams` (RN005). The new exam goes straight into the cached list, so
 * the row turns into "Abrir exame" at once. A refusal (closed event, student changed,
 * already confirmed by someone else) reloads the event, its exams and the students, so
 * the screen catches up with the API.
 */
export function useConfirmAttendance(eventId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (studentId: string) => confirmAttendance(api, eventId, studentId),
    onSuccess: (exam) => {
      queryClient.setQueryData<ExamView[]>(queryKeys.eventExams(eventId), (current) =>
        current && !current.some((item) => item.student_id === exam.student_id)
          ? [...current, exam]
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.eventExams(eventId) });
    },
    onError: (error) => {
      if (!(error instanceof ApiError) || ![400, 404, 409].includes(error.status)) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.eventExams(eventId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.events });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allStudents });
    },
  });
}
