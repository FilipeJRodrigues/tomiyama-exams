import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError, type ApiClient } from './client';
import { useApi } from './context';
import {
  compareRequirements,
  overlayRecentWrites,
  recordRequirementWrite,
} from './recentRequirementWrites';
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
  Requirement,
  RequirementFilters,
  RequirementInput,
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
  /** Prefix of every requirements list (any filter), for invalidation. */
  allRequirements: ['requirements'] as const,
  requirements: (filters: RequirementFilters = {}) => ['requirements', filters] as const,
};

/** Whether a query key is an exam sheet (`examSheet`): `['events', id, 'exams', studentId]`. */
export function isExamSheetKey(key: readonly unknown[]): boolean {
  return key.length === 4 && key[0] === 'events' && key[2] === 'exams';
}

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

export function listRequirements(
  api: ApiClient,
  filters: RequirementFilters = {},
): Promise<Requirement[]> {
  return api.get<Requirement[]>('/requirements', {
    belt_id: filters.belt_id,
    kind: filters.kind,
  });
}

function requirementPath(id: string): string {
  return `/requirements/${encodeURIComponent(id)}`;
}

/** `POST /requirements` (examiners, RN017). */
export function createRequirement(api: ApiClient, input: RequirementInput): Promise<Requirement> {
  return api.post<Requirement>('/requirements', input);
}

/** `PUT /requirements/{id}` with the same fields as the POST (RN017). */
export function updateRequirement(
  api: ApiClient,
  id: string,
  input: RequirementInput,
): Promise<Requirement> {
  return api.put<Requirement>(requirementPath(id), input);
}

/** `DELETE /requirements/{id}`; 409 when an exam has an answer for the item. */
export function deleteRequirement(api: ApiClient, id: string): Promise<void> {
  return api.delete(requirementPath(id));
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

/**
 * `GET /requirements` of one filter, in sheet order (`sort_order`). `enabled: false` waits
 * (the screen needs the belts to know its default belt). The answer goes through the recent
 * writes before reaching the cache: a late read of the `by_belt` GSI never undoes a write
 * the API has confirmed (see `recentRequirementWrites`).
 */
export function useRequirements(filters: RequirementFilters, enabled = true) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.requirements(filters),
    queryFn: async () =>
      overlayRecentWrites(queryClient, filters, await listRequirements(api, filters)),
    enabled,
  });
}

export { compareRequirements };

/**
 * A write confirmed by the API (`saved`, or `null` for an id that no longer exists): it is
 * recorded, laid over every cached list at once, and the lists reload (their answers go
 * through the same record, so a late one is corrected, never cancelled). The exam sheets in
 * cache reload too: their items and the RN007 totals come from the requirements (§ 6.4).
 *
 * The reload of a list that has data replaces a read still in flight (TanStack's
 * `cancelRefetch`), but a list still on its first load (or retrying after an error) would
 * only wait for that older read. So such a read is restarted first: it goes back to the
 * state before it, with no data to lose, and the active ones fetch again below; an inactive
 * one fetches when it is shown again.
 */
function applyConfirmedWrite(
  queryClient: QueryClient,
  id: string,
  saved: Requirement | null,
): void {
  recordRequirementWrite(queryClient, id, saved);
  const lists = queryClient.getQueriesData<Requirement[]>({
    queryKey: queryKeys.allRequirements,
  });
  for (const [key, data] of lists) {
    if (data === undefined) continue;
    const filters = (key[1] ?? {}) as RequirementFilters;
    queryClient.setQueryData<Requirement[]>(key, overlayRecentWrites(queryClient, filters, data));
  }
  const firstLoads = queryClient.getQueryCache().findAll({
    queryKey: queryKeys.allRequirements,
    predicate: (query) => query.state.fetchStatus === 'fetching' && query.state.data === undefined,
  });
  for (const query of firstLoads) void query.cancel({ revert: true });
  void queryClient.invalidateQueries({ queryKey: queryKeys.allRequirements });
  void queryClient.invalidateQueries({ predicate: (query) => isExamSheetKey(query.queryKey) });
}

/** The 404 of `PUT`/`DELETE /requirements/{id}` when the item does not exist. */
const MSG_REQUIREMENT_NOT_FOUND = 'Requisito não encontrado';

/**
 * A refusal of an edit or a deletion. 404 "Requisito não encontrado": the item no longer
 * exists (another examiner deleted it), so it is recorded as gone, as a confirmed deletion,
 * and a late read does not bring it back. Any other 404 or a 409: the list is behind the API
 * (answers registered meanwhile) and reloads.
 */
function reloadOnConflict(queryClient: QueryClient, id: string, error: unknown): void {
  if (!(error instanceof ApiError) || ![404, 409].includes(error.status)) return;
  if (error.status === 404 && error.message === MSG_REQUIREMENT_NOT_FOUND) {
    applyConfirmedWrite(queryClient, id, null);
  } else {
    void queryClient.invalidateQueries({ queryKey: queryKeys.allRequirements });
  }
}

/** `POST /requirements` (§ 6.5, RN017). */
export function useCreateRequirement() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RequirementInput) => createRequirement(api, input),
    onSuccess: (saved) => {
      applyConfirmedWrite(queryClient, saved.id, saved);
    },
  });
}

export interface UpdateRequirementVariables {
  id: string;
  input: RequirementInput;
}

/**
 * `PUT /requirements/{id}` (§ 6.5, RN017). 409 when the item has answers and the belt or
 * the kind changes; the message of the API is shown as is.
 */
export function useUpdateRequirement() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: UpdateRequirementVariables) => updateRequirement(api, id, input),
    onSuccess: (saved) => {
      applyConfirmedWrite(queryClient, saved.id, saved);
    },
    onError: (error, { id }) => {
      reloadOnConflict(queryClient, id, error);
    },
  });
}

/** `DELETE /requirements/{id}` (§ 6.5); 409 when an exam has an answer for the item. */
export function useDeleteRequirement() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRequirement(api, id),
    onSuccess: (_result, id) => {
      applyConfirmedWrite(queryClient, id, null);
    },
    onError: (error, id) => {
      reloadOnConflict(queryClient, id, error);
    },
  });
}
