import type { BeltLevel, ExamKind } from '../api/types';

/** pt-BR labels for the API enums; selects always show these. */
export const BELT_LEVEL_LABELS: Record<BeltLevel, string> = {
  BASIC: 'Básico',
  INTERMEDIATE: 'Intermediário',
};

export const EXAM_KIND_LABELS: Record<ExamKind, string> = {
  STRIPE: 'Grau',
  BELT: 'Faixa',
};
