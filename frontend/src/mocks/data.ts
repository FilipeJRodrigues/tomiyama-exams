/**
 * Fictional data for the simulated mode. Belts are the seed of the backend (same ids);
 * students follow the acceptance flow (§ 9). No real person here.
 */
import type {
  Belt,
  Eligibility,
  Exam,
  ExamAnswer,
  ExamEvent,
  Examiner,
  Requirement,
  RequirementKind,
  Student,
} from '../api/types';
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
  /**
   * Exams already registered (the backend `exam_count`). With at least one, guardians no
   * longer change the graduation (RN013) and nobody deletes the student (RN018).
   */
  examCount: number;
}

/** Same student with `count` registered exams. */
function withExams(item: MockStudent, count: number): MockStudent {
  return { ...item, examCount: count };
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
    examCount: 0,
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
  // Earned her stripe in an exam: she can be deactivated, never deleted (RN018).
  withExams(
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
    2,
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
  // A guardian's student with exams: only examiners change his graduation (RN013).
  withExams(
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
    1,
  ),
  // Already present at the open event (showcase exam below).
  withExams(
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
    1,
  ),
];

/** Ids of the simulated events (§ 6.3). */
export const MOCK_EVENT_IDS = {
  open: '5e1b7c2a-3d4f-4a6b-8c9d-0e1f2a3b4c01',
  closed: '5e1b7c2a-3d4f-4a6b-8c9d-0e1f2a3b4c02',
} as const;

/** One open and one closed event, most recent first (the order of `GET /events`). */
export const initialMockEvents: readonly ExamEvent[] = [
  {
    id: MOCK_EVENT_IDS.open,
    name: 'Exame novembro/2026',
    exam_date: '2026-11-21',
    status: 'OPEN',
    created_at: '2026-10-20T12:00:00+00:00',
    updated_at: '2026-10-20T12:00:00+00:00',
  },
  {
    id: MOCK_EVENT_IDS.closed,
    name: 'Exame março/2026',
    exam_date: '2026-03-01',
    status: 'CLOSED',
    created_at: '2026-02-10T12:00:00+00:00',
    updated_at: '2026-03-02T12:00:00+00:00',
  },
];

/** The student's graduation when the attendance was confirmed: belt, since, stripes. */
type Source = [belt: string, since: string, stripes: number];

function exam(
  eventId: string,
  studentId: string,
  target: string,
  kind: 'BELT' | 'STRIPE',
  status: Exam['status'],
  [sourceBelt, sourceSince, sourceStripes]: Source,
): Exam {
  const decided = status !== 'IN_PROGRESS';
  return {
    // UUID-shaped like the API's, fixed so tests can rely on it.
    id: `6f2c8d1e-4b3a-4c5d-9e6f-${eventId.slice(-2)}${studentId.slice(-10)}`,
    event_id: eventId,
    student_id: studentId,
    target_belt_id: beltId(target),
    kind,
    status,
    decided_by_id: decided ? examiner : null,
    decided_at: decided ? '2026-03-01T15:00:00+00:00' : null,
    notes: null,
    created_by: examiner,
    created_at: decided ? '2026-03-01T13:00:00+00:00' : '2026-11-02T12:00:00+00:00',
    source_belt_id: beltId(sourceBelt),
    source_belt_since: sourceSince,
    source_stripes: sourceStripes,
  };
}

/** Exams of the base students: Élida earned her stripe at the closed event. */
export const initialMockExams: readonly Exam[] = [
  exam(
    MOCK_EVENT_IDS.closed,
    '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05',
    'Roxa',
    'STRIPE',
    'APPROVED',
    ['Verde', '2024-05-20', 0],
  ),
];

/** Exams of the showcase students: Gabriel at the closed event, Helena at the open one. */
export const showcaseMockExams: readonly Exam[] = [
  exam(
    MOCK_EVENT_IDS.closed,
    '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e07',
    'Amarela/Laranja',
    'BELT',
    'APPROVED',
    ['Amarela', '2025-01-10', 0],
  ),
  exam(
    MOCK_EVENT_IDS.open,
    '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08',
    'Marrom',
    'BELT',
    'IN_PROGRESS',
    ['Roxa', '2025-06-30', 4],
  ),
];

/**
 * A few items of Appendix A per belt, in sheet order (the real sheets are much longer).
 * Branca/Cinza, the default of the requirements screen (§ 6.5), has its whole sheet.
 * Amarela/Laranja has no practical item here, so its practical percentage is "—" (RN007).
 */
const ITEMS: Record<string, [RequirementKind, string, string, string | null][]> = {
  'Branca/Cinza': [
    ['PRACTICE', 'Fundamentos', 'Demonstrar saudação em pé', 'Ritsurei'],
    ['PRACTICE', 'Fundamentos', 'Amortecimento de quedas (deitado)', 'Ushirokemi e Yokoukemi'],
    ['PRACTICE', 'Naguewaza', 'Deashi barai', null],
    ['PRACTICE', 'Naguewaza', 'Osoto gari', null],
    ['THEORY', 'Vocabulário', 'Professor', 'Sensei'],
    [
      'THEORY',
      'Vocabulário',
      'Contar até 10 em japonês',
      'iti, ni, san, shi, go, roku, shiti, rati, kyu, jú',
    ],
  ],
  'Cinza/Azul': [
    ['PRACTICE', 'Fundamentos', 'Demonstrar formas de pegar no kimono', 'Kumikata'],
    ['THEORY', 'Vocabulário', 'Uniforme do praticante do Judô', 'Judogui'],
  ],
  'Amarela/Laranja': [
    ['THEORY', 'Vocabulário', 'Parar', 'Mate'],
    ['THEORY', 'Histórico', 'Nome da primeira escola de Judô', 'Kodokan'],
  ],
  Verde: [
    ['PRACTICE', 'Naguewaza', 'Uki goshi', null],
    ['THEORY', 'Vocabulário', 'Peças que compõem o local de treino ou competição', 'Tatame'],
  ],
  Roxa: [
    ['PRACTICE', 'Naguewaza', 'Ogoshi', null],
    ['PRACTICE', 'Naguewaza', 'Koshi guruma', null],
    ['THEORY', 'Vocabulário', 'Professor', 'Sensei'],
  ],
  Marrom: [
    ['PRACTICE', 'Fundamentos', 'Demonstrar saudação em pé', 'Ritsurei'],
    ['PRACTICE', 'Fundamentos', 'Demonstrar saudação ajoelhado', 'Zarei'],
    ['PRACTICE', 'Naguewaza', 'Deashi barai', null],
    ['PRACTICE', 'Naguewaza', 'Osoto gari', null],
    ['THEORY', 'Vocabulário', 'Professor', 'Sensei'],
    ['THEORY', 'Vocabulário', 'Parar', 'Mate'],
    ['THEORY', 'Histórico', 'Nome do fundador do Judô', 'Jigoro Kano'],
  ],
};

function hex(value: number): string {
  return value.toString(16).padStart(6, '0');
}

/** UUID-shaped id of the `order`-th item (1-based) of a belt, fixed so tests can rely on it. */
export function mockRequirementId(belt: string, order: number): string {
  const sortOrder = mockBelts.find((item) => item.name === belt)?.sort_order ?? 0;
  return `9a1e0c3b-6d2f-4e8a-8b7c-${hex(sortOrder)}${hex(order)}`;
}

export const mockRequirements: readonly Requirement[] = Object.entries(ITEMS).flatMap(
  ([belt, items]) =>
    items.map(([kind, category, description, expected], index) => ({
      id: mockRequirementId(belt, index + 1),
      belt_id: beltId(belt),
      kind,
      category,
      description,
      expected_answer: expected,
      sort_order: index + 1,
    })),
);

/** A mark as stored: the API answer plus the exam it belongs to. */
export interface MockAnswer extends ExamAnswer {
  exam_id: string;
}

function answer(examItem: Exam, belt: string, order: number, correct: boolean): MockAnswer {
  return {
    exam_id: examItem.id,
    requirement_id: mockRequirementId(belt, order),
    correct,
    marked_by: examiner,
    marked_at: examItem.decided_at ?? '2026-11-21T13:30:00+00:00',
  };
}

function marks(examItem: Exam | undefined, belt: string, values: [number, boolean][]) {
  return examItem ? values.map(([order, correct]) => answer(examItem, belt, order, correct)) : [];
}

/**
 * Marks of the decided exams (every item) and of Helena's, in progress: 1 of 3 theory
 * items marked and 2 of 4 practical ones.
 */
function initialAnswers(exams: readonly Exam[]): MockAnswer[] {
  const of = (studentSuffix: string) =>
    exams.find((item) => item.student_id.endsWith(studentSuffix));
  return [
    ...marks(of('4e05'), 'Roxa', [
      [1, true],
      [2, true],
      [3, true],
    ]),
    ...marks(of('4e07'), 'Amarela/Laranja', [
      [1, true],
      [2, false],
    ]),
    ...marks(of('4e08'), 'Marrom', [
      [1, true],
      [2, false],
      [5, true],
    ]),
  ];
}

/** Active examiners (`GET /examiners`), by name; the second one has no name. */
export const mockExaminers: readonly Examiner[] = [
  { id: examiner, email: 'examinador@example.com', name: 'Sensei Simulado' },
  { id: 'mock-examiner-2', email: 'examinadora@example.com', name: null },
];

/** The academy settings as stored (`GET /settings` adds the sensei's account). */
export interface MockSettings {
  academy_name: string | null;
  sensei_user_id: string | null;
  certificate_city: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface MockDb {
  settings: MockSettings;
  belts: Belt[];
  students: MockStudent[];
  events: ExamEvent[];
  exams: Exam[];
  requirements: Requirement[];
  answers: MockAnswer[];
  examiners: Examiner[];
}

export interface MockDbOptions {
  /**
   * Add `showcaseMockStudents` and their exams (browser simulated mode and the list screen
   * tests).
   */
  includeShowcase?: boolean;
  /**
   * The sensei of the settings (RN008). By default the second examiner, so the signed-in
   * simulated examiner sees "A decisão é do sensei …"; the browser simulated mode makes him
   * the sensei so the whole decision can be tried. `null`: no sensei.
   */
  senseiId?: string | null;
}

function copy(item: MockStudent): MockStudent {
  return {
    student: { ...item.student },
    eligibility: { ...item.eligibility, reasons: [...item.eligibility.reasons] },
    examCount: item.examCount,
  };
}

export function createMockDb({
  includeShowcase = false,
  senseiId = 'mock-examiner-2',
}: MockDbOptions = {}): MockDb {
  const students = includeShowcase
    ? [...initialMockStudents, ...showcaseMockStudents]
    : initialMockStudents;
  const exams = includeShowcase ? [...initialMockExams, ...showcaseMockExams] : initialMockExams;
  return {
    settings: {
      academy_name: 'Academia Simulada de Judô',
      sensei_user_id: senseiId,
      certificate_city: 'Cidade Simulada',
      created_at: '2026-10-01T12:00:00+00:00',
      updated_at: '2026-10-01T12:00:00+00:00',
    },
    belts: mockBelts.map((belt) => ({ ...belt })),
    students: students.map(copy),
    events: initialMockEvents.map((event) => ({ ...event })),
    exams: exams.map((item) => ({ ...item })),
    requirements: mockRequirements.map((item) => ({ ...item })),
    answers: initialAnswers(exams),
    examiners: mockExaminers.map((item) => ({ ...item })),
  };
}
