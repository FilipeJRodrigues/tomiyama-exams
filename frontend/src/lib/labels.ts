import type { BeltLevel, EventStatus, ExamKind, ExamStatus, RequirementKind } from '../api/types';

/** pt-BR labels for the API enums; selects always show these. */
export const BELT_LEVEL_LABELS: Record<BeltLevel, string> = {
  BASIC: 'Básico',
  INTERMEDIATE: 'Intermediário',
};

export const EXAM_KIND_LABELS: Record<ExamKind, string> = {
  STRIPE: 'Grau',
  BELT: 'Faixa',
};

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  OPEN: 'Aberto',
  CLOSED: 'Encerrado',
};

export const EXAM_STATUS_LABELS: Record<ExamStatus, string> = {
  IN_PROGRESS: 'Em andamento',
  APPROVED: 'Aprovado',
  FAILED: 'Reprovado',
};

export const REQUIREMENT_KIND_LABELS: Record<RequirementKind, string> = {
  THEORY: 'Teórico',
  PRACTICE: 'Prático',
};
