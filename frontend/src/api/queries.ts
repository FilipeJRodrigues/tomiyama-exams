import {
  hashKey,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { ApiError, NETWORK_ERROR_STATUS, type ApiClient } from './client';
import { useApi } from './context';
import { compareEvents, overlayRecentEventWrites, recordEventWrite } from './recentEventWrites';
import {
  compareRequirements,
  overlayRecentWrites,
  recordRequirementWrite,
} from './recentRequirementWrites';
import type {
  AcademySettings,
  AcademySettingsInput,
  AnswerResult,
  Belt,
  BeltInput,
  ConfirmAttendanceInput,
  DecisionInput,
  DecisionOutcome,
  EventCreateInput,
  EventUpdateInput,
  ExamEvent,
  ExamSheet,
  ExamView,
  Examiner,
  LogoMeta,
  LogoSlot,
  LogoUploadInput,
  LogoView,
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
  /**
   * Not under `settings`: reloading or cancelling the settings (their save, the decision)
   * must not cancel a logo read on its way.
   */
  logo: (slot: LogoSlot) => ['logos', slot] as const,
  /**
   * The slot's mark "the logo may have changed" (`useLogoChange`). Not under `logos`, so
   * reloading or cancelling the slot's read never touches it.
   */
  logoChange: (slot: LogoSlot) => ['logoChange', slot] as const,
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

function eventPath(id: string): string {
  return `/events/${encodeURIComponent(id)}`;
}

/** `POST /events` (examiners, RN016). */
export function createEvent(api: ApiClient, input: EventCreateInput): Promise<ExamEvent> {
  return api.post<ExamEvent>('/events', input);
}

/** `PUT /events/{id}`: name and status (RN016). */
export function updateEvent(
  api: ApiClient,
  id: string,
  input: EventUpdateInput,
): Promise<ExamEvent> {
  return api.put<ExamEvent>(eventPath(id), input);
}

/** `DELETE /events/{id}`; 409 when the event has exams (RN016). */
export function deleteEvent(api: ApiClient, id: string): Promise<void> {
  return api.delete(eventPath(id));
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

/** `PUT /settings` (examiners; only the admin master changes the sensei). */
export function updateSettings(
  api: ApiClient,
  input: AcademySettingsInput,
): Promise<AcademySettings> {
  return api.put<AcademySettings>('/settings', input);
}

/**
 * `GET /settings/logos/{slot}` (RN012): the logo with its pre-signed URL, or `null` when the
 * slot is empty (404 "Logo não encontrado" is the empty slot, not an error of the screen).
 */
export async function getLogo(api: ApiClient, slot: LogoSlot): Promise<LogoView | null> {
  try {
    return await api.get<LogoView>(`/settings/logos/${slot}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** `PUT /settings/logos/{slot}`: sends or replaces the logo; answers its metadata. */
export function uploadLogo(
  api: ApiClient,
  slot: LogoSlot,
  input: LogoUploadInput,
): Promise<LogoMeta> {
  return api.put<LogoMeta>(`/settings/logos/${slot}`, input);
}

/** `DELETE /settings/logos/{slot}`: 204, also when the slot had no logo. */
export function deleteLogo(api: ApiClient, slot: LogoSlot): Promise<void> {
  return api.delete(`/settings/logos/${slot}`);
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

/**
 * `GET /events`, from the most recent to the oldest (examiners only). The answer goes through
 * the recent writes before reaching the cache: the API reads the list with a `Scan` that is
 * eventually consistent, and a late answer never undoes a write it has confirmed (see
 * `recentEventWrites`).
 */
export function useEvents() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.events,
    queryFn: async () => overlayRecentEventWrites(queryClient, await listEvents(api)),
  });
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

/**
 * `GET /examiners`: active examiners, to show who decided an exam and to choose the sensei
 * (§ 6.6). `enabled: false` skips the request (only the admin master chooses the sensei).
 */
export function useExaminers(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.examiners, queryFn: () => listExaminers(api), enabled });
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

/** `PUT /settings` refusals after which the screen reloads the settings (§ 6.6). */
const MSG_ONLY_MASTER_CHOOSES_SENSEI = 'Somente o administrador master escolhe o sensei';
const MSG_SENSEI_NOT_ACTIVE_EXAMINER = 'O sensei precisa ser um examinador ativo';

/**
 * `PUT /settings` (§ 3.7, § 6.6). The answer (same as the `GET`) goes straight into the cache,
 * after cancelling a read still on its way, so an older answer never takes the saved data
 * back. A refusal about the sensei reloads what made it: the stored sensei changed meanwhile
 * (403 for a non-master), or the chosen one is no longer an active examiner (400: the settings
 * and the examiners). With no answer (network, 504) the settings may have been saved: they
 * reload too.
 */
export function useUpdateSettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AcademySettingsInput) => updateSettings(api, input),
    onSuccess: async (saved) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.settings });
      queryClient.setQueryData<AcademySettings>(queryKeys.settings, saved);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      const unknownOutcome = error.status === NETWORK_ERROR_STATUS || error.status === 504;
      if (
        unknownOutcome ||
        error.message === MSG_ONLY_MASTER_CHOOSES_SENSEI ||
        error.message === MSG_SENSEI_NOT_ACTIVE_EXAMINER
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      }
      if (error.message === MSG_SENSEI_NOT_ACTIVE_EXAMINER) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.examiners });
      }
    },
  });
}

/**
 * How long a logo read stays fresh: below the 300 s of its pre-signed URL, so a reload on
 * window focus or on opening the screen again brings a URL still valid. A URL that expires
 * while the screen stays open is replaced by the screen when the image fails to load.
 */
export const LOGO_STALE_TIME_MS = 240_000;

/** `GET /settings/logos/{slot}` (§ 6.6): `null` is the empty slot. */
export function useLogo(slot: LogoSlot) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.logo(slot),
    queryFn: () => getLogo(api, slot),
    staleTime: LOGO_STALE_TIME_MS,
  });
}

/**
 * The mark "the logo may have changed" of a slot (§ 6.6, RN012): a write stored the logo, or
 * may have, and no read of the slot has worked since. While it is on, the cached logo (or the
 * empty slot) may not be what the slot has: the screen shows the read error with "Tentar de
 * novo" (or "Carregando logo…" while a read is on its way), never that preview and never
 * "Trocar"/"Remover".
 *
 * It lives in the `QueryClient` (`queryKeys.logoChange`), not in the screen, so it outlives
 * the slot panel (leaving the screen and coming back) and ends with the session (`clear`).
 * - On: `useUploadLogo` and `useDeleteLogo`, when the write stored the logo (PUT 200) or may
 *   have (no answer, 504, 5xx) and the read again, awaited, did not bring the slot: it failed,
 *   or did not run because no screen shows the slot.
 * - Off: only a read of the slot that works (its answer reaches the cache, `watchLogoReads`),
 *   and the 204 of a removal, which says the slot is empty as a read would.
 */
export interface LogoChange {
  /**
   * `stored`: the API stored the logo sent (PUT 200), so the read that turns the mark off
   * brings it and the screen says "salvo". `unknown`: the write may or may not have happened.
   */
  outcome: 'stored' | 'unknown';
}

const LOGO_SLOTS: readonly LogoSlot[] = ['primary', 'secondary'];

/** The slot whose logo read has this query hash (`['logos', slot]`), or null. */
function logoSlotOf(queryHash: string): LogoSlot | null {
  return LOGO_SLOTS.find((slot) => hashKey(queryKeys.logo(slot)) === queryHash) ?? null;
}

/** The clients whose cache already turns the logo marks off (one listener per session). */
const watchedClients = new WeakSet<QueryClient>();

/**
 * Turns a slot's mark off when a read of the slot works: the answer of the `GET` reaches the
 * cache (the `success` of a fetch). A read cancelled or answered too late for the cache never
 * gets here, and neither does data the screen puts in the cache itself (`setQueryData`).
 */
function watchLogoReads(queryClient: QueryClient): void {
  if (watchedClients.has(queryClient)) return;
  watchedClients.add(queryClient);
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) {
      return;
    }
    const slot = logoSlotOf(event.query.queryHash);
    if (slot === null) return;
    const markKey = queryKeys.logoChange(slot);
    if (queryClient.getQueryData<LogoChange | null>(markKey)) {
      queryClient.setQueryData<LogoChange | null>(markKey, null);
    }
  });
}

function markLogoChanged(queryClient: QueryClient, slot: LogoSlot, change: LogoChange): void {
  watchLogoReads(queryClient);
  queryClient.setQueryData<LogoChange | null>(queryKeys.logoChange(slot), change);
}

/**
 * Reads the slot again after a write and says whether the read brought it. A read already on
 * its way (asked before the write) is cancelled first, so only a read asked after the write
 * can answer. With no screen on the slot nothing is read: that is not a confirmation.
 */
async function readLogoAgain(queryClient: QueryClient, slot: LogoSlot): Promise<boolean> {
  const queryKey = queryKeys.logo(slot);
  await queryClient.cancelQueries({ queryKey, exact: true });
  await queryClient.invalidateQueries({ queryKey, exact: true });
  const state = queryClient.getQueryState(queryKey);
  return state?.status === 'success' && !state.isInvalidated;
}

/** Reads the slot again; when the read does not bring it, the slot's mark goes on. */
async function confirmLogoWrite(
  queryClient: QueryClient,
  slot: LogoSlot,
  outcome: LogoChange['outcome'],
): Promise<boolean> {
  const read = await readLogoAgain(queryClient, slot);
  if (!read) markLogoChanged(queryClient, slot, { outcome });
  return read;
}

/** The slot's mark (`LogoChange`), or `null` while it is off. */
export function useLogoChange(slot: LogoSlot): LogoChange | null {
  const { data } = useQuery<LogoChange | null>({
    queryKey: queryKeys.logoChange(slot),
    // Never fetched: only the writes of the slot and its reads change it.
    queryFn: skipToken,
    initialData: null,
    staleTime: Infinity,
    // Kept for the whole session, also while no screen shows the slot.
    gcTime: Infinity,
  });
  return data ?? null;
}

/** Whether a failed logo write may have been stored anyway (no answer, 504 or 5xx). */
function logoMayHaveChanged(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && (error.status === NETWORK_ERROR_STATUS || error.status >= 500)
  );
}

/** How a stored logo ended: whether the read again brought its new URL. */
export interface LogoUploadResult {
  /**
   * `false` when the logo was stored but the read again did not bring it: the slot's mark is
   * on (`useLogoChange`) until a read works.
   */
  reloaded: boolean;
}

/**
 * `PUT /settings/logos/{slot}` (RN012). The answer has no URL: the slot is read again, and the
 * mutation only ends when that read is over, so the preview never shows the old image after
 * "salvo". When the read fails the logo is stored all the same: the mutation succeeds with
 * `reloaded: false`, and the slot's mark goes on.
 * A 400 or 413 stores nothing (the logo stays). With no answer, a 504 or a 5xx the file may be
 * in the bucket already (README, "Ordem das gravações"): the slot is read again before the
 * error comes out, and the mark goes on when that read fails. The exception is a 503 on an
 * empty slot: its metadata was not stored, so the slot is still empty (the `GET` answers 404).
 */
export function useUploadLogo(slot: LogoSlot) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogoUploadInput): Promise<LogoUploadResult> => {
      const wasEmpty = queryClient.getQueryData(queryKeys.logo(slot)) === null;
      try {
        await uploadLogo(api, slot, input);
      } catch (error) {
        if (logoMayHaveChanged(error)) {
          const read = await readLogoAgain(queryClient, slot);
          const stillEmpty = wasEmpty && error.status === 503;
          if (!read && !stillEmpty) markLogoChanged(queryClient, slot, { outcome: 'unknown' });
        }
        throw error;
      }
      return { reloaded: await confirmLogoWrite(queryClient, slot, 'stored') };
    },
  });
}

/**
 * `DELETE /settings/logos/{slot}`: the slot becomes empty in the cache, after cancelling a
 * read on its way, and its mark goes off (the 204 says the slot is empty). With no answer or a
 * 5xx the metadata may be gone already: the slot is read again before the error comes out, and
 * the mark goes on when that read fails.
 */
export function useDeleteLogo(slot: LogoSlot) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await deleteLogo(api, slot);
      } catch (error) {
        if (logoMayHaveChanged(error)) await confirmLogoWrite(queryClient, slot, 'unknown');
        throw error;
      }
    },
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.logo(slot) });
      queryClient.setQueryData<LogoView | null>(queryKeys.logo(slot), null);
      queryClient.setQueryData<LogoChange | null>(queryKeys.logoChange(slot), null);
    },
  });
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
 * Restarts the reads of these lists that are still on their first load (or retrying after an
 * error): a reload would only wait for such an older read, while a list with data has its
 * read replaced (TanStack's `cancelRefetch`). A restarted read goes back to the state before
 * it, with no data to lose; the active ones fetch again on the invalidation that follows, an
 * inactive one when it is shown again.
 */
function restartFirstLoads(
  queryClient: QueryClient,
  filters: { queryKey: readonly unknown[]; exact?: boolean },
): void {
  const firstLoads = queryClient.getQueryCache().findAll({
    ...filters,
    predicate: (query) => query.state.fetchStatus === 'fetching' && query.state.data === undefined,
  });
  for (const query of firstLoads) void query.cancel({ revert: true });
}

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
  restartFirstLoads(queryClient, { queryKey: queryKeys.allRequirements });
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

/**
 * An event write confirmed by the API (`saved`, or `null` for an id that no longer exists):
 * it is recorded, laid over the cached list at once (so the exam day picks the right open
 * event), and the list reloads; its answer goes through the same record, so a late `Scan`
 * is corrected, never cancelled. After an edit, what is cached under the event (its exams
 * and exam sheets, which show its name and status) reloads too: a closed event blocks
 * attendance and marking (RN016).
 */
function applyConfirmedEventWrite(
  queryClient: QueryClient,
  id: string,
  saved: ExamEvent | null,
  { edited = false }: { edited?: boolean } = {},
): void {
  recordEventWrite(queryClient, id, saved);
  queryClient.setQueryData<ExamEvent[]>(
    queryKeys.events,
    (current) => current && overlayRecentEventWrites(queryClient, current),
  );
  // Exact: `['events']` is also the prefix of the event exams and the exam sheets.
  restartFirstLoads(queryClient, { queryKey: queryKeys.events, exact: true });
  void queryClient.invalidateQueries({ queryKey: queryKeys.events, exact: true });
  if (edited) void queryClient.invalidateQueries({ queryKey: queryKeys.eventExams(id) });
}

/** The 404 of `PUT`/`DELETE /events/{id}` when the event does not exist. */
const MSG_EVENT_NOT_FOUND = 'Evento não encontrado';

/**
 * A refusal of an edit or a deletion. 404 "Evento não encontrado": the event no longer exists
 * (another examiner deleted it), so it is recorded as gone and a late read does not bring it
 * back. A 409 (exams registered meanwhile): the list reloads.
 */
function reloadEventsOnConflict(queryClient: QueryClient, id: string, error: unknown): void {
  if (!(error instanceof ApiError) || ![404, 409].includes(error.status)) return;
  if (error.status === 404 && error.message === MSG_EVENT_NOT_FOUND) {
    applyConfirmedEventWrite(queryClient, id, null);
  } else {
    void queryClient.invalidateQueries({ queryKey: queryKeys.events, exact: true });
  }
}

/** `POST /events` (§ 6.5, RN016); without `status` the API uses `OPEN`. */
export function useCreateEvent() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: EventCreateInput) => createEvent(api, input),
    onSuccess: (saved) => {
      applyConfirmedEventWrite(queryClient, saved.id, saved);
    },
  });
}

export interface UpdateEventVariables {
  id: string;
  input: EventUpdateInput;
}

/** `PUT /events/{id}` (§ 6.5, RN016): name and status; a closed event may be reopened. */
export function useUpdateEvent() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: UpdateEventVariables) => updateEvent(api, id, input),
    onSuccess: (saved) => {
      applyConfirmedEventWrite(queryClient, saved.id, saved, { edited: true });
    },
    onError: (error, { id }) => {
      reloadEventsOnConflict(queryClient, id, error);
    },
  });
}

/** `DELETE /events/{id}` (§ 6.5); 409 "Evento possui exames registrados" (RN016). */
export function useDeleteEvent() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteEvent(api, id),
    onSuccess: (_result, id) => {
      applyConfirmedEventWrite(queryClient, id, null);
    },
    onError: (error, id) => {
      reloadEventsOnConflict(queryClient, id, error);
    },
  });
}

export { compareEvents };

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
