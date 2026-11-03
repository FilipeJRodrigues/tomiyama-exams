/**
 * MSW handlers that follow the contract in `backend/README.md`. They check the
 * simulated token like the JWT authorizer, filter students by owner like the API and
 * answer the student form with the backend messages (`domain/students.py`,
 * `domain/validation.py`): RN013, RN014 and RN018. The exam day (§ 6.3) gets the event
 * list and the attendance confirmation (`handlers/events.py`, `handlers/exams.py`,
 * `domain/exams.py`): RN005 and RN016. The exam screen (§ 6.4) gets the exam sheet with the
 * RN007 summary (`get_exam_sheet`, `domain/scoring.py`), the marking of its items
 * (`mark_answer`, `unmark_answer`, `domain/answers.py`: RN006, RN010, RN016) and the
 * examiners (`handlers/users.py`).
 */
import { http, HttpResponse, type HttpHandler } from 'msw';

import { buildApiUrl } from '../api/client';
import type {
  Eligibility,
  Exam,
  ExamEvent,
  ExamSheet,
  ExamSheetItem,
  ExamSummary,
  ExamView,
  KindSummary,
  RequirementKind,
  Student,
  StudentView,
} from '../api/types';
import { decodeMockToken, type MockClaims } from '../auth/mockToken';
import { EXAMINER_GROUP } from '../auth/types';
import { ageInYears, parseIsoDate, todayIso } from '../lib/dates';
import { foldText } from '../lib/text';
import { createMockDb, type MockDb, type MockStudent } from './data';

function claimsFrom(request: Request): MockClaims | null {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '');
  return token ? decodeMockToken(token) : null;
}

/** API Gateway answers 401 in English before the Lambda runs. */
function unauthorized() {
  return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
}

function badRequest(message: string) {
  return HttpResponse.json({ message }, { status: 400 });
}

function errorResponse(status: number, message: string) {
  return HttpResponse.json({ message }, { status });
}

const MSG_STUDENT_NOT_FOUND = 'Aluno não encontrado';
const MSG_GRADUATION_LOCKED = 'Somente examinadores alteram a graduação após o primeiro exame';
const MSG_STUDENT_HAS_EXAMS = 'Aluno possui exames registrados';
const MSG_INVALID_DATES = 'Datas inválidas: verifique nascimento e data da faixa atual';
const MSG_INVALID_BODY = 'Corpo da requisição inválido: envie um objeto JSON';
const MAX_STRIPES = 4;
const MSG_EXAMINERS_ONLY = 'Esta área é dos examinadores';
const MSG_EVENT_NOT_FOUND = 'Evento não encontrado';
const MSG_ALREADY_CONFIRMED = 'Presença já confirmada neste evento';
const MSG_EVENT_CLOSED = 'Evento encerrado';
const MSG_STUDENT_INACTIVE = 'Aluno inativo não pode fazer exame';
const MSG_EXAM_NOT_FOUND = 'Exame não encontrado';
const MSG_REQUIREMENT_NOT_FOUND = 'Requisito não encontrado';
const MSG_INVALID_CORRECT = 'Marcação inválida: envie correct como true (certo) ou false (errado)';
const MSG_EXAM_DECIDED = 'Exame já decidido';
const MSG_ITEM_NOT_IN_BELT = 'Item não pertence à faixa do exame';

/**
 * The mock does not compute eligibility (RN001–RN004 live in the backend). A student
 * created here, or whose dates or graduation changed, gets this fixed answer instead.
 */
function unknownEligibility(): Eligibility {
  return {
    eligible: false,
    kind: null,
    target_belt_id: null,
    target_belt_name: null,
    reasons: ['Elegibilidade não calculada no modo simulado'],
  };
}

/** Validation error with the backend pt-BR message (answered as 400). */
class MockValidationError extends Error {}

type Payload = Record<string, unknown>;
type StudentFields = Pick<
  Student,
  | 'full_name'
  | 'birth_date'
  | 'current_belt_id'
  | 'current_belt_since'
  | 'stripes'
  | 'federation_id'
  | 'active'
>;

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

/** Python counts code points, not UTF-16 units. */
function lengthOf(text: string): number {
  return Array.from(text).length;
}

function requiredStr(payload: Payload, field: string, label: string, maxLen: number): string {
  const value = payload[field];
  if (isBlank(value)) throw new MockValidationError(`Campo obrigatório: ${label}`);
  if (typeof value !== 'string') throw new MockValidationError(`${label}: valor inválido`);
  const trimmed = value.trim();
  if (lengthOf(trimmed) > maxLen) {
    throw new MockValidationError(`${label}: máximo de ${maxLen} caracteres`);
  }
  return trimmed;
}

function optionalStr(payload: Payload, field: string, label: string, maxLen: number) {
  return isBlank(payload[field]) ? null : requiredStr(payload, field, label, maxLen);
}

function dateField(payload: Payload, field: string, label: string): string {
  const value = payload[field];
  if (value === null || value === undefined || value === '') {
    throw new MockValidationError(`Campo obrigatório: ${label}`);
  }
  if (typeof value !== 'string' || !parseIsoDate(value)) {
    throw new MockValidationError(`${label}: data inválida (use AAAA-MM-DD)`);
  }
  return value;
}

function stripesField(payload: Payload): number {
  const value = payload.stripes;
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MockValidationError('Graus: deve ser um número inteiro');
  }
  if (value < 0 || value > MAX_STRIPES) {
    throw new MockValidationError(`Graus: deve estar entre 0 e ${MAX_STRIPES}`);
  }
  return value;
}

function activeField(payload: Payload): boolean {
  const value = payload.active;
  if (value === null || value === undefined) return true;
  if (typeof value !== 'boolean') throw new MockValidationError('Ativo: valor inválido');
  return value;
}

/** Same checks, in the same order, as `_parse_fields` in the backend. */
function parseStudentFields(db: MockDb, payload: Payload): StudentFields {
  const fields: StudentFields = {
    full_name: requiredStr(payload, 'full_name', 'Nome', 120),
    birth_date: dateField(payload, 'birth_date', 'Nascimento'),
    current_belt_id: requiredStr(payload, 'current_belt_id', 'Faixa atual', 64),
    current_belt_since: dateField(payload, 'current_belt_since', 'Na faixa desde'),
    stripes: stripesField(payload),
    federation_id: optionalStr(payload, 'federation_id', 'Registro na federação', 30),
    active: activeField(payload),
  };
  if (!db.belts.some((belt) => belt.id === fields.current_belt_id)) {
    throw new MockValidationError('Faixa atual: faixa não encontrada');
  }
  // RN014. `AAAA-MM-DD` strings compare like the dates they hold.
  const today = todayIso();
  if (
    fields.birth_date > today ||
    fields.current_belt_since > today ||
    fields.current_belt_since < fields.birth_date
  ) {
    throw new MockValidationError(MSG_INVALID_DATES);
  }
  return fields;
}

async function readPayload(request: Request): Promise<Payload> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new MockValidationError(MSG_INVALID_BODY);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new MockValidationError(MSG_INVALID_BODY);
  }
  return body as Payload;
}

function graduationChanged(before: Student, after: StudentFields): boolean {
  return (
    before.current_belt_id !== after.current_belt_id ||
    before.current_belt_since !== after.current_belt_since ||
    before.stripes !== after.stripes
  );
}

function isExaminer(claims: MockClaims): boolean {
  return claims['cognito:groups'].includes(EXAMINER_GROUP);
}

/** Like `ensure_can_access`: someone else's student is reported as not found. */
function findAccessible(db: MockDb, id: unknown, claims: MockClaims): MockStudent | null {
  const item = db.students.find((candidate) => candidate.student.id === id);
  if (!item || (!isExaminer(claims) && item.student.owner_id !== claims.sub)) return null;
  return item;
}

/** Run a write handler, answering validation errors with 400 like the backend. */
async function withValidation(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MockValidationError) return badRequest(error.message);
    throw error;
  }
}

const nameCollator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

function toView(db: MockDb, item: MockStudent, reference: string): StudentView {
  const belt = db.belts.find((candidate) => candidate.id === item.student.current_belt_id);
  return {
    ...item.student,
    current_belt_name: belt?.name ?? null,
    age: ageInYears(item.student.birth_date, reference),
    eligibility: item.eligibility,
  };
}

/** Like `sort_events`: most recent `exam_date` first, then the newest created, then id. */
function sortEvents(events: ExamEvent[]): ExamEvent[] {
  const key = (event: ExamEvent) => `${event.exam_date}|${event.created_at}|${event.id}`;
  return [...events].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

/** Like `name_sort_key`: folded name, then the original name, then the student id. */
function compareExamViews(a: ExamView, b: ExamView): number {
  const keys = (view: ExamView) => {
    const name = view.student_name ?? '';
    return [foldText(name), name, view.student_id];
  };
  const [ka, kb] = [keys(a), keys(b)];
  for (let i = 0; i < ka.length; i++) {
    const [x = '', y = ''] = [ka[i], kb[i]];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function examView(db: MockDb, exam: Exam): ExamView {
  const item = db.students.find((candidate) => candidate.student.id === exam.student_id);
  return { ...exam, student_name: item?.student.full_name ?? null };
}

/**
 * Like `scoring.score`: correct ÷ items of the kind × 100, one decimal rounded half up;
 * unmarked items count as not correct; `null` without items of the kind (RN007).
 */
function kindSummary(items: readonly ExamSheetItem[], kind: RequirementKind): KindSummary {
  const ofKind = items.filter((item) => item.kind === kind);
  const marked = ofKind.filter((item) => item.answer !== null);
  const correct = marked.filter((item) => item.answer?.correct).length;
  const total = ofKind.length;
  // Integer math first: `correct * 1000 / total` is exact whenever the result ends in .5.
  const percent = total === 0 ? null : Math.round((correct * 1000) / total) / 10;
  return { kind, total, marked: marked.length, correct, percent };
}

function examSummary(items: readonly ExamSheetItem[]): ExamSummary {
  return { THEORY: kindSummary(items, 'THEORY'), PRACTICE: kindSummary(items, 'PRACTICE') };
}

/** Like `get_exam_sheet`: the exam, the event, the student, the target belt and the items. */
function examSheet(db: MockDb, event: ExamEvent, exam: Exam): ExamSheet {
  const item = db.students.find((candidate) => candidate.student.id === exam.student_id);
  const items: ExamSheetItem[] = db.requirements
    .filter((requirement) => requirement.belt_id === exam.target_belt_id)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((requirement) => {
      const mark = db.answers.find(
        (candidate) => candidate.exam_id === exam.id && candidate.requirement_id === requirement.id,
      );
      const answer = mark
        ? {
            requirement_id: mark.requirement_id,
            correct: mark.correct,
            marked_by: mark.marked_by,
            marked_at: mark.marked_at,
          }
        : null;
      return { ...requirement, answer };
    });
  return {
    exam: examView(db, exam),
    event: { ...event },
    student: item
      ? {
          id: item.student.id,
          full_name: item.student.full_name,
          birth_date: item.student.birth_date,
        }
      : null,
    target_belt: db.belts.find((belt) => belt.id === exam.target_belt_id) ?? null,
    items,
    summary: examSummary(items),
  };
}

type MarkingContext =
  { error: Response } | { error: null; event: ExamEvent; exam: Exam; requirementId: string };

/** Like `_marking_context`: 404 for the event, the exam, then the requirement. */
function markingContext(
  db: MockDb,
  params: Record<string, string | readonly string[] | undefined>,
): MarkingContext {
  const event = db.events.find((candidate) => candidate.id === params.id);
  if (!event) return { error: errorResponse(404, MSG_EVENT_NOT_FOUND) };
  const exam = db.exams.find(
    (candidate) => candidate.event_id === event.id && candidate.student_id === params.studentId,
  );
  if (!exam) return { error: errorResponse(404, MSG_EXAM_NOT_FOUND) };
  const requirement = db.requirements.find((candidate) => candidate.id === params.requirementId);
  if (!requirement) return { error: errorResponse(404, MSG_REQUIREMENT_NOT_FOUND) };
  return { error: null, event, exam, requirementId: requirement.id };
}

/** Like `ensure_can_mark`: decided exam (RN010), closed event (RN016), item of another belt. */
function markingRefusal(db: MockDb, event: ExamEvent, exam: Exam, requirementId: string) {
  if (exam.status !== 'IN_PROGRESS') return errorResponse(409, MSG_EXAM_DECIDED);
  if (event.status !== 'OPEN') return badRequest(MSG_EVENT_CLOSED);
  const requirement = db.requirements.find((candidate) => candidate.id === requirementId);
  if (requirement?.belt_id !== exam.target_belt_id) return badRequest(MSG_ITEM_NOT_IN_BELT);
  return null;
}

export interface MockHandlersOptions {
  baseUrl: string;
  db?: MockDb;
}

export function createHandlers({
  baseUrl,
  db = createMockDb(),
}: MockHandlersOptions): HttpHandler[] {
  const url = (path: string) => buildApiUrl(baseUrl, path);

  return [
    http.get(url('/belts'), ({ request }) => {
      if (!claimsFrom(request)) return unauthorized();
      const belts = [...db.belts].sort((a, b) => a.sort_order - b.sort_order);
      return HttpResponse.json(belts);
    }),

    http.get(url('/students'), ({ request }) => {
      const claims = claimsFrom(request);
      if (!claims) return unauthorized();
      const params = new URL(request.url).searchParams;

      const active = params.get('active');
      if (active !== null && active !== 'true' && active !== 'false') {
        return badRequest('Filtro ativo: use true ou false');
      }
      // Like the backend, an empty value counts as absent (today).
      const reference = params.get('reference_date') || todayIso();
      if (!parseIsoDate(reference)) {
        return badRequest('Data de referência: data inválida (use AAAA-MM-DD)');
      }
      const beltId = params.get('belt_id');
      const examiner = isExaminer(claims);

      const students = db.students
        .filter((item) => examiner || item.student.owner_id === claims.sub)
        .filter((item) => active === null || item.student.active === (active === 'true'))
        .filter((item) => !beltId || item.student.current_belt_id === beltId)
        .sort((a, b) => nameCollator.compare(a.student.full_name, b.student.full_name))
        .map((item) => toView(db, item, reference));
      return HttpResponse.json(students);
    }),

    http.post(url('/students'), ({ request }) => {
      const claims = claimsFrom(request);
      if (!claims) return unauthorized();
      return withValidation(async () => {
        const fields = parseStudentFields(db, await readPayload(request));
        const now = new Date().toISOString();
        const item: MockStudent = {
          student: {
            id: crypto.randomUUID(),
            // The owner always comes from the token, never from the body.
            owner_id: claims.sub,
            ...fields,
            created_at: now,
            updated_at: now,
          },
          eligibility: unknownEligibility(),
          examCount: 0,
        };
        db.students.push(item);
        return HttpResponse.json(toView(db, item, todayIso()), { status: 201 });
      });
    }),

    http.get(url('/students/:id'), ({ request, params }) => {
      const claims = claimsFrom(request);
      if (!claims) return unauthorized();
      const reference = new URL(request.url).searchParams.get('reference_date') || todayIso();
      if (!parseIsoDate(reference)) {
        return badRequest('Data de referência: data inválida (use AAAA-MM-DD)');
      }
      const item = findAccessible(db, params.id, claims);
      if (!item) return errorResponse(404, MSG_STUDENT_NOT_FOUND);
      return HttpResponse.json(toView(db, item, reference));
    }),

    http.put(url('/students/:id'), ({ request, params }) => {
      const claims = claimsFrom(request);
      if (!claims) return unauthorized();
      const item = findAccessible(db, params.id, claims);
      if (!item) return errorResponse(404, MSG_STUDENT_NOT_FOUND);
      return withValidation(async () => {
        const fields = parseStudentFields(db, await readPayload(request));
        const before = item.student;
        const changed = graduationChanged(before, fields);
        // RN013: resending the same graduation is fine; changing it is examiner-only.
        if (changed && item.examCount > 0 && !isExaminer(claims)) {
          return errorResponse(403, MSG_GRADUATION_LOCKED);
        }
        item.student = { ...before, ...fields, updated_at: new Date().toISOString() };
        if (changed || fields.birth_date !== before.birth_date) {
          item.eligibility = unknownEligibility();
        }
        return HttpResponse.json(toView(db, item, todayIso()));
      });
    }),

    http.delete(url('/students/:id'), ({ request, params }) => {
      const claims = claimsFrom(request);
      if (!claims) return unauthorized();
      const item = findAccessible(db, params.id, claims);
      if (!item) return errorResponse(404, MSG_STUDENT_NOT_FOUND);
      // RN018: exams are never deleted in cascade; the student may be deactivated.
      if (item.examCount > 0) return errorResponse(409, MSG_STUDENT_HAS_EXAMS);
      db.students = db.students.filter((candidate) => candidate !== item);
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(url('/events'), ({ request }) => {
      const claims = claimsFrom(request);
      if (!claims) return unauthorized();
      if (!isExaminer(claims)) return errorResponse(403, MSG_EXAMINERS_ONLY);
      return HttpResponse.json(sortEvents(db.events));
    }),

    http.get(url('/events/:id/exams'), ({ request, params }) => {
      const claims = claimsFrom(request);
      if (!claims) return unauthorized();
      if (!isExaminer(claims)) return errorResponse(403, MSG_EXAMINERS_ONLY);
      const event = db.events.find((candidate) => candidate.id === params.id);
      if (!event) return errorResponse(404, MSG_EVENT_NOT_FOUND);
      const views = db.exams
        .filter((exam) => exam.event_id === event.id)
        .map((exam) => examView(db, exam))
        .sort(compareExamViews);
      return HttpResponse.json(views);
    }),

    // RN005, in the order of `confirm_attendance` in `handlers/exams.py`.
    http.post(url('/events/:id/exams'), ({ request, params }) => {
      const claims = claimsFrom(request);
      if (!claims) return unauthorized();
      if (!isExaminer(claims)) return errorResponse(403, MSG_EXAMINERS_ONLY);
      const event = db.events.find((candidate) => candidate.id === params.id);
      if (!event) return errorResponse(404, MSG_EVENT_NOT_FOUND);
      return withValidation(async () => {
        const studentId = requiredStr(await readPayload(request), 'student_id', 'Aluno', 64);
        const item = db.students.find((candidate) => candidate.student.id === studentId);
        if (!item) return errorResponse(404, MSG_STUDENT_NOT_FOUND);
        if (db.exams.some((exam) => exam.event_id === event.id && exam.student_id === studentId)) {
          return errorResponse(409, MSG_ALREADY_CONFIRMED);
        }
        // RN016, then RN005: active and eligible (the mock's fixed eligibility).
        if (event.status !== 'OPEN') return badRequest(MSG_EVENT_CLOSED);
        if (!item.student.active) return badRequest(MSG_STUDENT_INACTIVE);
        const { eligible, kind, target_belt_id: target, reasons } = item.eligibility;
        if (!eligible || !kind || !target) return badRequest(reasons.join('; '));
        const exam: Exam = {
          id: crypto.randomUUID(),
          event_id: event.id,
          student_id: studentId,
          target_belt_id: target,
          kind,
          status: 'IN_PROGRESS',
          decided_by_id: null,
          decided_at: null,
          notes: null,
          created_by: claims.sub,
          created_at: new Date().toISOString(),
          source_belt_id: item.student.current_belt_id,
          source_belt_since: item.student.current_belt_since,
          source_stripes: item.student.stripes,
        };
        db.exams.push(exam);
        item.examCount += 1;
        return HttpResponse.json(examView(db, exam), { status: 201 });
      });
    }),

    http.get(url('/events/:id/exams/:studentId'), ({ request, params }) => {
      const claims = claimsFrom(request);
      if (!claims) return unauthorized();
      if (!isExaminer(claims)) return errorResponse(403, MSG_EXAMINERS_ONLY);
      const event = db.events.find((candidate) => candidate.id === params.id);
      if (!event) return errorResponse(404, MSG_EVENT_NOT_FOUND);
      const exam = db.exams.find(
        (candidate) => candidate.event_id === event.id && candidate.student_id === params.studentId,
      );
      if (!exam) return errorResponse(404, MSG_EXAM_NOT_FOUND);
      return HttpResponse.json(examSheet(db, event, exam));
    }),

    // RN006: mark (replacing any mark) and unmark, with the summary after the write (RN007).
    http.put(url('/events/:id/exams/:studentId/answers/:requirementId'), ({ request, params }) => {
      const claims = claimsFrom(request);
      if (!claims) return unauthorized();
      if (!isExaminer(claims)) return errorResponse(403, MSG_EXAMINERS_ONLY);
      const context = markingContext(db, params);
      if (context.error) return context.error;
      const { event, exam, requirementId } = context;
      return withValidation(async () => {
        const correct = (await readPayload(request)).correct;
        if (typeof correct !== 'boolean') return badRequest(MSG_INVALID_CORRECT);
        const refusal = markingRefusal(db, event, exam, requirementId);
        if (refusal) return refusal;
        const answer = {
          requirement_id: requirementId,
          correct,
          marked_by: claims.sub,
          marked_at: new Date().toISOString(),
        };
        db.answers = [
          ...db.answers.filter(
            (item) => !(item.exam_id === exam.id && item.requirement_id === requirementId),
          ),
          { exam_id: exam.id, ...answer },
        ];
        return HttpResponse.json({ answer, summary: examSheet(db, event, exam).summary });
      });
    }),

    http.delete(
      url('/events/:id/exams/:studentId/answers/:requirementId'),
      ({ request, params }) => {
        const claims = claimsFrom(request);
        if (!claims) return unauthorized();
        if (!isExaminer(claims)) return errorResponse(403, MSG_EXAMINERS_ONLY);
        const context = markingContext(db, params);
        if (context.error) return context.error;
        const { event, exam, requirementId } = context;
        const refusal = markingRefusal(db, event, exam, requirementId);
        if (refusal) return refusal;
        db.answers = db.answers.filter(
          (item) => !(item.exam_id === exam.id && item.requirement_id === requirementId),
        );
        return HttpResponse.json({ answer: null, summary: examSheet(db, event, exam).summary });
      },
    ),

    http.get(url('/examiners'), ({ request }) => {
      const claims = claimsFrom(request);
      if (!claims) return unauthorized();
      if (!isExaminer(claims)) return errorResponse(403, MSG_EXAMINERS_ONLY);
      return HttpResponse.json(db.examiners);
    }),
  ];
}
