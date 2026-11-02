/**
 * Types of the API payloads, mirroring the backend `to_dict()` (see `backend/README.md`).
 * Dates without time are `AAAA-MM-DD` strings; timestamps are ISO 8601 strings.
 */

export type IsoDate = string;
export type IsoDateTime = string;

export type BeltLevel = 'BASIC' | 'INTERMEDIATE';
export type ExamKind = 'STRIPE' | 'BELT';

/** `GET /belts` item. */
export interface Belt {
  id: string;
  name: string;
  kyu: number | null;
  sort_order: number;
  level: BeltLevel;
  min_age_years: number;
  min_months_previous: number;
  /** `#RRGGBB` */
  color_primary: string;
  color_secondary: string | null;
}

/** Eligibility computed by the API on the reference date (never computed here). */
export interface Eligibility {
  eligible: boolean;
  kind: ExamKind | null;
  target_belt_id: string | null;
  target_belt_name: string | null;
  /** Blocking reasons in pt-BR; empty when eligible. */
  reasons: string[];
}

/** Student as stored. */
export interface Student {
  id: string;
  owner_id: string;
  full_name: string;
  birth_date: IsoDate;
  current_belt_id: string;
  current_belt_since: IsoDate;
  stripes: number;
  federation_id: string | null;
  active: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime | null;
}

/** `GET /students` item: the student plus the fields the API computes. */
export interface StudentView extends Student {
  current_belt_name: string | null;
  age: number;
  eligibility: Eligibility;
}

/**
 * Body of `POST /students` and `PUT /students/{id}`. The form always sends every field:
 * resending the same belt, belt date and stripes is accepted after the first exam (RN013).
 */
export interface StudentInput {
  full_name: string;
  birth_date: IsoDate;
  current_belt_id: string;
  current_belt_since: IsoDate;
  stripes: number;
  federation_id: string | null;
  active: boolean;
}

export interface StudentFilters {
  active?: boolean;
  belt_id?: string;
  reference_date?: IsoDate;
}

/** Error body returned by the backend and by API Gateway. */
export interface ApiErrorBody {
  message?: string;
}
