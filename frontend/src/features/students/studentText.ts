/**
 * Texts of the students list (§ 6.2). Everything here only formats what the API sent:
 * age, target belt, exam kind and blocking reasons are computed by the backend
 * (RN001–RN004) and never recalculated in the browser.
 */
import type { Eligibility, StudentView } from '../../api/types';
import { formatDate, parseIsoDate } from '../../lib/dates';

/** `0` → empty, `1` → `1 grau`, `2` → `2 graus`. */
export function stripesLabel(stripes: number): string {
  if (stripes <= 0) return '';
  return stripes === 1 ? '1 grau' : `${stripes} graus`;
}

/** `Verde · 2 graus`; just the name when there is no stripe. */
export function beltLabel(beltName: string | null, stripes: number): string {
  const name = beltName ?? '—';
  const extra = stripesLabel(stripes);
  return extra ? `${name} · ${extra}` : name;
}

/** `1 ano`, `8 anos`. */
export function ageLabel(age: number): string {
  return age === 1 ? '1 ano' : `${age} anos`;
}

/** `AAAA-MM-DD` → `dd/mm/aaaa`; `—` when the API sends something that is not a date. */
export function dateLabel(isoDate: string): string {
  return parseIsoDate(isoDate) ? formatDate(isoDate) : '—';
}

/** `Faixa Cinza/Azul`, `Grau (rumo à Roxa)` or `—` when there is no next exam. */
export function nextExamLabel(eligibility: Eligibility): string {
  const target = eligibility.target_belt_name;
  if (!target || !eligibility.kind) return '—';
  return eligibility.kind === 'BELT' ? `Faixa ${target}` : `Grau (rumo à ${target})`;
}

export type StudentStatusKind = 'inactive' | 'eligible' | 'blocked';

export interface StudentStatus {
  kind: StudentStatusKind;
  label: string;
}

/** `Inativo` (wins over the rest), `Elegível` or `Bloqueado: {reasons}`. */
export function studentStatus(student: Pick<StudentView, 'active' | 'eligibility'>): StudentStatus {
  if (!student.active) return { kind: 'inactive', label: 'Inativo' };
  const { eligible, reasons } = student.eligibility;
  if (eligible) return { kind: 'eligible', label: 'Elegível' };
  const label = reasons.length > 0 ? `Bloqueado: ${reasons.join('; ')}` : 'Bloqueado';
  return { kind: 'blocked', label };
}
