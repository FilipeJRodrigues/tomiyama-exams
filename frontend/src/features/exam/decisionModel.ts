/**
 * Sensei decision on the exam screen (§ 6.4, RN008–RN010): who may decide, the texts of the
 * confirmation and who decided. Who the sensei is comes from `GET /settings`; whether the
 * decision is accepted is always the API's call (this only picks what to show).
 */
import type {
  AcademySettings,
  Belt,
  DecisionResult,
  ExamSheet,
  ExamStatus,
  Examiner,
  SettingsSensei,
} from '../../api/types';
import { examinerName, stripeBelt } from './examModel';

/** Longest note the API takes (`notes`, RN008). */
export const NOTES_MAX_LENGTH = 500;

/**
 * What the signed-in examiner sees while the exam is in progress:
 * - `sensei`: Aprovar / Reprovar;
 * - `other`: "A decisão é do sensei {nome}" (the master too, unless he is the sensei);
 * - `noSensei` / `inactiveSensei`: a notice with a link to the academy settings.
 */
export type DecisionRole =
  | { kind: 'sensei' }
  | { kind: 'other'; senseiName: string | undefined }
  | { kind: 'noSensei' }
  | { kind: 'inactiveSensei' };

/** Name of a person, else the e-mail; undefined when the API sends neither. */
export function personName(person: Pick<SettingsSensei, 'name' | 'email'>): string | undefined {
  return person.name?.trim() || person.email?.trim() || undefined;
}

export function decisionRole(
  settings: Pick<AcademySettings, 'sensei'>,
  userId: string | undefined,
): DecisionRole {
  const { sensei } = settings;
  if (!sensei) return { kind: 'noSensei' };
  if (!sensei.active) return { kind: 'inactiveSensei' };
  if (userId !== undefined && sensei.id === userId) return { kind: 'sensei' };
  return { kind: 'other', senseiName: personName(sensei) };
}

/** `A decisão é do sensei Tomiyama`, or without the name when the API has none. */
export function senseiOnlyText(senseiName: string | undefined): string {
  return senseiName ? `A decisão é do sensei ${senseiName}` : 'A decisão é do sensei';
}

/**
 * Who decided: an active examiner (`GET /examiners`), else the sensei of the settings (the
 * one who usually decides, also when no longer active); undefined when neither names him.
 */
export function deciderName(
  deciderId: string,
  examiners: readonly Examiner[] | undefined,
  sensei: SettingsSensei | null | undefined,
): string | undefined {
  const examiner = examiners ? examinerName(examiners, deciderId) : undefined;
  if (examiner) return examiner;
  return sensei?.id === deciderId ? personName(sensei) : undefined;
}

/**
 * `Decidido por Tomiyama`; while the names load, `Decidido`; when nobody names the decider,
 * a neutral text.
 */
export function decidedByText(name: string | undefined, namesLoaded: boolean): string {
  if (name) return `Decidido por ${name}`;
  return namesLoaded ? 'Decidido por um examinador que não está mais ativo' : 'Decidido';
}

const VERBS: Record<DecisionResult, string> = { APPROVED: 'Aprovar', FAILED: 'Reprovar' };

export function decisionTitle(result: DecisionResult): string {
  return `${VERBS[result]} exame`;
}

export function decisionButtonLabel(result: DecisionResult): string {
  return VERBS[result];
}

const IRREVERSIBLE = 'A decisão não pode ser desfeita.';

/**
 * The confirmation question (§ 6.4): `Aprovar Ana para a faixa Cinza/Azul? A decisão não
 * pode ser desfeita.`; the failure says `no exame da faixa`, and a stripe exam (RN004) names
 * the belt the stripe is earned in (`no exame de grau na faixa Roxa`).
 */
export function confirmationText(
  result: DecisionResult,
  sheet: Pick<ExamSheet, 'exam' | 'student' | 'target_belt'>,
  belts: readonly Belt[] | undefined,
): string {
  const name = sheet.student?.full_name ?? sheet.exam.student_name ?? 'o aluno';
  const verb = VERBS[result];
  const target = sheet.target_belt;
  let what: string;
  if (sheet.exam.kind === 'BELT') {
    if (!target) what = 'no exame de faixa';
    else
      what =
        result === 'APPROVED' ? `para a faixa ${target.name}` : `no exame da faixa ${target.name}`;
  } else {
    const belt = target && belts ? stripeBelt(sheet.exam.source_belt_id, target, belts) : undefined;
    what = belt ? `no exame de grau na faixa ${belt.name}` : 'no exame de grau';
  }
  return `${verb} ${name} ${what}? ${IRREVERSIBLE}`;
}

/** Read out once the decision is saved (§ 6.7). */
export function decisionAnnouncement(status: ExamStatus): string {
  if (status === 'APPROVED') return 'Exame aprovado.';
  if (status === 'FAILED') return 'Exame reprovado.';
  return '';
}
