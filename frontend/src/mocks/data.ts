/**
 * Fictional data for the simulated mode. Belts are the seed of the backend (same ids);
 * students follow the acceptance flow (§ 9). No real person here.
 */
import type { Belt, Eligibility, Student } from '../api/types';
import { MOCK_USER_IDS } from '../auth/mockConstants';

export const mockBelts: Belt[] = [
  {
    id: 'a6f1715c-fe65-5e06-aab3-20ae0fdc6fff',
    name: 'Branca',
    kyu: null,
    sort_order: 0,
    level: 'BASIC',
    min_age_years: 0,
    min_months_previous: 0,
    color_primary: '#FFFFFF',
    color_secondary: null,
  },
  {
    id: '05f7fec2-abac-5039-ba88-0bc4b84259b3',
    name: 'Branca/Cinza',
    kyu: 11,
    sort_order: 1,
    level: 'BASIC',
    min_age_years: 4,
    min_months_previous: 3,
    color_primary: '#FFFFFF',
    color_secondary: '#9E9E9E',
  },
  {
    id: '312a6c3e-04d8-51cc-a3b0-0dfec1701953',
    name: 'Cinza',
    kyu: 10,
    sort_order: 2,
    level: 'BASIC',
    min_age_years: 5,
    min_months_previous: 3,
    color_primary: '#9E9E9E',
    color_secondary: null,
  },
  {
    id: '8c22ac1d-c2e8-5d3c-bfeb-1f99ef5ae51c',
    name: 'Cinza/Azul',
    kyu: 9,
    sort_order: 3,
    level: 'BASIC',
    min_age_years: 6,
    min_months_previous: 6,
    color_primary: '#9E9E9E',
    color_secondary: '#1E63C6',
  },
  {
    id: 'ef0279ce-3ba5-557b-883d-748e7b933199',
    name: 'Azul',
    kyu: 8,
    sort_order: 4,
    level: 'BASIC',
    min_age_years: 7,
    min_months_previous: 6,
    color_primary: '#1E63C6',
    color_secondary: null,
  },
  {
    id: '598fce10-0a32-5fa6-aee5-b61e1faa5bc6',
    name: 'Azul/Amarela',
    kyu: 7,
    sort_order: 5,
    level: 'BASIC',
    min_age_years: 8,
    min_months_previous: 6,
    color_primary: '#1E63C6',
    color_secondary: '#F2C200',
  },
  {
    id: '3c8197f3-8a41-556d-9973-7429dd6ac30d',
    name: 'Amarela',
    kyu: 6,
    sort_order: 6,
    level: 'BASIC',
    min_age_years: 9,
    min_months_previous: 6,
    color_primary: '#F2C200',
    color_secondary: null,
  },
  {
    id: 'b00d1ac6-ff0c-5489-a3f5-558efb02ef6f',
    name: 'Amarela/Laranja',
    kyu: 5,
    sort_order: 7,
    level: 'BASIC',
    min_age_years: 10,
    min_months_previous: 12,
    color_primary: '#F2C200',
    color_secondary: '#F07C00',
  },
  {
    id: '02cd0641-9b93-51c5-80aa-e74ab02540ff',
    name: 'Laranja',
    kyu: 4,
    sort_order: 8,
    level: 'INTERMEDIATE',
    min_age_years: 11,
    min_months_previous: 12,
    color_primary: '#F07C00',
    color_secondary: null,
  },
  {
    id: '81234933-c2d8-5a45-bfea-54bb0b12c9ab',
    name: 'Verde',
    kyu: 3,
    sort_order: 9,
    level: 'INTERMEDIATE',
    min_age_years: 12,
    min_months_previous: 12,
    color_primary: '#2E8B3A',
    color_secondary: null,
  },
  {
    id: 'd6b1448e-5a57-56b3-a7d8-875516cffbba',
    name: 'Roxa',
    kyu: 2,
    sort_order: 10,
    level: 'INTERMEDIATE',
    min_age_years: 13,
    min_months_previous: 12,
    color_primary: '#6B2FA0',
    color_secondary: null,
  },
  {
    id: '966882f6-48d3-5898-8c69-2e310133b008',
    name: 'Marrom',
    kyu: 1,
    sort_order: 11,
    level: 'INTERMEDIATE',
    min_age_years: 14,
    min_months_previous: 12,
    color_primary: '#6D4423',
    color_secondary: null,
  },
];

function beltId(name: string): string {
  const belt = mockBelts.find((item) => item.name === name);
  if (!belt) throw new Error(`Faixa simulada inexistente: ${name}`);
  return belt.id;
}

/**
 * A simulated student with a fixed eligibility. The real one is computed by the API;
 * the mock does not reimplement the rules, so it ignores `reference_date` here.
 */
export interface MockStudent {
  student: Student;
  eligibility: Eligibility;
}

const CREATED_AT = '2026-10-01T12:00:00+00:00';

function student(
  id: string,
  owner: string,
  fullName: string,
  birthDate: string,
  belt: string,
  since: string,
  stripes: number,
  eligibility: Eligibility,
  active = true,
): MockStudent {
  return {
    student: {
      id,
      owner_id: owner,
      full_name: fullName,
      birth_date: birthDate,
      current_belt_id: beltId(belt),
      current_belt_since: since,
      stripes,
      federation_id: null,
      active,
      created_at: CREATED_AT,
      updated_at: null,
    },
    eligibility,
  };
}

function eligible(kind: 'BELT' | 'STRIPE', target: string): Eligibility {
  return {
    eligible: true,
    kind,
    target_belt_id: beltId(target),
    target_belt_name: target,
    reasons: [],
  };
}

function blocked(kind: 'BELT' | 'STRIPE', target: string, reasons: string[]): Eligibility {
  return {
    eligible: false,
    kind,
    target_belt_id: beltId(target),
    target_belt_name: target,
    reasons,
  };
}

const guardian = MOCK_USER_IDS.guardian;
const examiner = MOCK_USER_IDS.examiner;

/** Initial simulated students; `createMockDb` copies them so tests never share state. */
export const initialMockStudents: readonly MockStudent[] = [
  student(
    '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01',
    guardian,
    'Ana Souza',
    '2018-05-10',
    'Cinza',
    '2026-03-14',
    0,
    eligible('BELT', 'Cinza/Azul'),
  ),
  student(
    '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e02',
    guardian,
    'Bruno Souza',
    '2019-08-20',
    'Azul',
    '2025-11-01',
    0,
    blocked('BELT', 'Azul/Amarela', ['Idade mínima para a faixa Azul/Amarela: 8 anos']),
  ),
  student(
    '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03',
    examiner,
    'Carla Mendes',
    '2012-02-29',
    'Laranja',
    '2025-09-10',
    0,
    eligible('STRIPE', 'Verde'),
  ),
  student(
    '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e04',
    examiner,
    'Davi Oliveira',
    '2016-01-15',
    'Branca',
    '2026-09-01',
    0,
    blocked('BELT', 'Branca/Cinza', ['Carência mínima de 3 meses na faixa atual (faltam 1)']),
  ),
  student(
    '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05',
    examiner,
    'Élida Ramos',
    '2010-07-03',
    'Verde',
    '2024-05-20',
    1,
    eligible('BELT', 'Roxa'),
    false,
  ),
];

/**
 * Extra students that complete the cases of the list (§ 6.2): two blocking reasons, the
 * last belt (no next exam here) and 2 to 4 stripes. Kept apart so the base set above stays
 * the one the API tests count on.
 */
export const showcaseMockStudents: readonly MockStudent[] = [
  student(
    '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e06',
    examiner,
    'Fábio Lima',
    '2008-04-22',
    'Marrom',
    '2024-02-10',
    3,
    {
      eligible: false,
      kind: null,
      target_belt_id: null,
      target_belt_name: null,
      reasons: ['Faixa preta é exame da federação'],
    },
  ),
  student(
    '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e07',
    guardian,
    'Gabriel Costa',
    '2017-12-05',
    'Amarela/Laranja',
    '2026-03-01',
    2,
    blocked('BELT', 'Laranja', [
      'Idade mínima para a faixa Laranja: 11 anos',
      'Carência mínima de 12 meses na faixa atual (faltam 4)',
    ]),
  ),
  student(
    '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08',
    examiner,
    'Helena Prado',
    '2011-06-18',
    'Roxa',
    '2025-06-30',
    4,
    eligible('BELT', 'Marrom'),
  ),
];

export interface MockDb {
  belts: Belt[];
  students: MockStudent[];
}

export interface MockDbOptions {
  /** Add `showcaseMockStudents` (browser simulated mode and the list screen tests). */
  includeShowcase?: boolean;
}

function copy(item: MockStudent): MockStudent {
  return {
    student: { ...item.student },
    eligibility: { ...item.eligibility, reasons: [...item.eligibility.reasons] },
  };
}

export function createMockDb({ includeShowcase = false }: MockDbOptions = {}): MockDb {
  const students = includeShowcase
    ? [...initialMockStudents, ...showcaseMockStudents]
    : initialMockStudents;
  return {
    belts: mockBelts.map((belt) => ({ ...belt })),
    students: students.map(copy),
  };
}
