import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, type ApiClient } from './client';
import { useApi } from './context';
import type {
  AcademySettings,
  AnswerResult,
  Belt,
  BeltInput,
  ConfirmAttendanceInput,
  DecisionInput,
  DecisionOutcome,
  ExamEvent,
  ExamSheet,
  ExamView,
  Examiner,
  MarkAnswerInput,
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
  /** Prefix of every student detail, for invalidation. */
  anyStudent: ['student'] as const,
  events: ['events'] as const,
  eventExams: (eventId: string) => ['events', eventId, 'exams'] as const,
  /** Under `eventExams`: reloading the event's exams also reloads the open exam sheet. */
  examSheet: (eventId: string, studentId: string) =>
    ['events', eventId, 'exams', studentId] as const,
  examiners: ['examiners'] as const,
  settings: ['settings'] as const,
};

export function listBelts(api: ApiClient): Promise<Belt[]> {
  return api.get<Belt[]>('/belts');
}

/** `PUT /belts/{id}` (examiners, RN015). */
export function updateBelt(api: ApiClient, id: string, input: BeltInput): Promise<Belt> {
  return api.put<Belt>(`/belts/${encodeURIComponent(id)}`, input);
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

function answerPath(eventId: string, studentId: string, requirementId: string): string {
  return `${eventExamsPath(eventId)}/${encodeURIComponent(studentId)}/answers/${encodeURIComponent(requirementId)}`;
}

/** `PUT …/answers/{requirement_id}`: mark the item certo or errado, replacing any mark (RN006). */
export function markAnswer(
  api: ApiClient,
  eventId: string,
  studentId: string,
  requirementId: string,
  correct: boolean,
): Promise<AnswerResult> {
  const body: MarkAnswerInput = { correct };
  return api.put<AnswerResult>(answerPath(eventId, studentId, requirementId), body);
}

/** `DELETE …/answers/{requirement_id}`: back to "não marcado" (also 200 when it was not). */
export function unmarkAnswer(
  api: ApiClient,
  eventId: string,
  studentId: string,
  requirementId: string,
): Promise<AnswerResult> {
  return api.delete<AnswerResult>(answerPath(eventId, studentId, requirementId));
}

/** `POST …/decision`: the sensei approves or fails the exam (RN008, RN009, RN010). */
export function decideExam(
  api: ApiClient,
  eventId: string,
  studentId: string,
  input: DecisionInput,
): Promise<DecisionOutcome> {
  return api.post<DecisionOutcome>(
    `${eventExamsPath(eventId)}/${encodeURIComponent(studentId)}/decision`,
    input,
  );
}

export function getSettings(api: ApiClient): Promise<AcademySettings> {
  return api.get<AcademySettings>('/settings');
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

export interface UpdateBeltVariables {
  id: string;
  input: BeltInput;
}

/**
 * `PUT /belts/{id}` (§ 6.5, RN015). The saved belt goes straight into the cached list, in
 * graduation order, and then the list reloads. The students reload too: their belt name
 * (and the detail's) comes from the belts. A 404 or 409 (belt gone, name or order taken meanwhile) reloads the
 * list, so the screen catches up with the API.
 */
export function useUpdateBelt() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: UpdateBeltVariables) => updateBelt(api, id, input),
    onSuccess: (saved) => {
      queryClient.setQueryData<Belt[]>(
        queryKeys.belts,
        (current) =>
          current &&
          current
            .map((belt) => (belt.id === saved.id ? saved : belt))
            .sort((a, b) => a.sort_order - b.sort_order),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.belts });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allStudents });
      void queryClient.invalidateQueries({ queryKey: queryKeys.anyStudent });
    },
    onError: (error) => {
      if (!(error instanceof ApiError) || ![404, 409].includes(error.status)) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.belts });
    },
  });
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

export interface ExamSheetOptions {
  /**
   * Asked when the window gets the focus back; `false` skips that reload (the exam screen
   * holds it while a mark is on its way, so the optimistic marks do not flicker).
   */
  canReloadOnFocus?: () => boolean;
}

/**
 * `GET /events/{id}/exams/{student_id}` (§ 6.4): the exam, its items with the marks and the
 * RN007 summary. Reloaded whenever the window gets the focus back, so two examiners on the
 * same exam see each other's marks (set here explicitly, not only as the app default).
 */
export function useExamSheet(
  eventId: string,
  studentId: string,
  { canReloadOnFocus }: ExamSheetOptions = {},
) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.examSheet(eventId, studentId),
    queryFn: () => getExamSheet(api, eventId, studentId),
    refetchOnWindowFocus: canReloadOnFocus
      ? () => (canReloadOnFocus() ? 'always' : false)
      : 'always',
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

/** `GET /settings`: the academy settings, here for who the sensei is (RN008). */
export function useSettings() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.settings, queryFn: () => getSettings(api) });
}

/** API messages after which the screen reloads what it shows (RN008, RN010). */
export const MSG_EXAM_ALREADY_DECIDED = 'Exame já decidido';
const MSG_SENSEI_ONLY = 'Somente o sensei pode decidir o exame';
const MSG_NO_SENSEI = 'Defina o sensei nas configurações da academia';
const MSG_GRADUATION_CHANGED =
  'A graduação do aluno mudou desde a presença. Confira antes de decidir.';

/** The exam was decided meanwhile (by another device, or a repeated request). */
export function isAlreadyDecided(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 409 && error.message === MSG_EXAM_ALREADY_DECIDED
  );
}

/**
 * `POST /events/{id}/exams/{student_id}/decision` (RN008). The decided exam goes straight
 * into the cached sheet, so the screen turns read-only at once (RN010); then the exam, the
 * event's exams and the students reload (RN009 changed the student's graduation). A refusal
 * reloads what made it: the exam ("Exame já decidido", graduation changed), the settings
 * (sensei changed or removed) or the student.
 */
export function useDecideExam(eventId: string, studentId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const reloadExam = () => {
    // Under `eventExams`: also reloads this exam's sheet.
    void queryClient.invalidateQueries({ queryKey: queryKeys.eventExams(eventId) });
  };
  const reloadStudents = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.allStudents });
    void queryClient.invalidateQueries({ queryKey: queryKeys.student(studentId) });
  };
  return useMutation({
    mutationFn: (input: DecisionInput) => decideExam(api, eventId, studentId, input),
    onSuccess: ({ exam }) => {
      queryClient.setQueryData<ExamSheet>(
        queryKeys.examSheet(eventId, studentId),
        (sheet) => sheet && { ...sheet, exam: { ...sheet.exam, ...exam } },
      );
      reloadExam();
      reloadStudents();
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.status === 404 || isAlreadyDecided(error)) {
        reloadExam();
      } else if (error.message === MSG_SENSEI_ONLY || error.message === MSG_NO_SENSEI) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      } else if (error.message === MSG_GRADUATION_CHANGED) {
        reloadExam();
        reloadStudents();
      }
    },
  });
}
