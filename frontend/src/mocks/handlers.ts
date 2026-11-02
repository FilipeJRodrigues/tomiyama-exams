/**
 * MSW handlers that follow the contract in `backend/README.md`. They check the
 * simulated token like the JWT authorizer and filter students by owner like the API.
 */
import { http, HttpResponse, type HttpHandler } from 'msw';

import { buildApiUrl } from '../api/client';
import type { StudentView } from '../api/types';
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
      const isExaminer = claims['cognito:groups'].includes(EXAMINER_GROUP);

      const students = db.students
        .filter((item) => isExaminer || item.student.owner_id === claims.sub)
        .filter((item) => active === null || item.student.active === (active === 'true'))
        .filter((item) => !beltId || item.student.current_belt_id === beltId)
        .sort((a, b) => nameCollator.compare(a.student.full_name, b.student.full_name))
        .map((item) => toView(db, item, reference));
      return HttpResponse.json(students);
    }),
  ];
}
