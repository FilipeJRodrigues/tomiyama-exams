/**
 * MSW handlers that follow the contract in `backend/README.md`. They check the
 * simulated token like the JWT authorizer, filter students by owner like the API and
 * answer the student form with the backend messages (`domain/students.py`,
 * `domain/validation.py`): RN013, RN014 and RN018.
 */
import { http, HttpResponse, type HttpHandler } from 'msw';

import { buildApiUrl } from '../api/client';
import type { Eligibility, Student, StudentView } from '../api/types';
import { decodeMockToken, type MockClaims } from '../auth/mockToken';
import { EXAMINER_GROUP } from '../auth/types';
import { ageInYears, parseIsoDate, todayIso } from '../lib/dates';
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
  ];
}
